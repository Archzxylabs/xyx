// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {XYXPasskeyRegistry} from "./XYXPasskeyRegistry.sol";

/// @notice Commitment-only escrow for private AI delivery and passkey-backed settlement.
contract XYXDeliveryProtocol is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    enum JobStatus { Proposed, Accepted, Funded, Submitted, Completed, Rejected, Expired, Cancelled }

    struct Job {
        address buyer;
        address provider;
        address attestor;
        bytes32 termsCommitment;
        bytes32 deliveryCommitment;
        uint256 budget;
        uint64 expiresAt;
        JobStatus status;
    }

    struct JobVerdict {
        uint256 jobId;
        bytes32 termsCommitment;
        bytes32 deliveryCommitment;
        bytes32 evidenceCommitment;
        bytes32 reasonCommitment;
        uint8 decision;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 nonce;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "JobVerdict(uint256 jobId,bytes32 termsCommitment,bytes32 deliveryCommitment,bytes32 evidenceCommitment,bytes32 reasonCommitment,uint8 decision,uint64 issuedAt,uint64 expiresAt,uint64 nonce)"
    );

    IERC20 public immutable paymentToken;
    XYXPasskeyRegistry public immutable passkeyRegistry;
    uint64 public immutable maxVerdictLifetime;
    uint256 public jobCounter;
    mapping(uint256 => Job) private jobs;
    mapping(bytes32 => bool) public consumedVerdicts;
    mapping(address => mapping(uint64 => bool)) public usedNonces;

    error InvalidConfiguration();
    error InvalidJob();
    error InvalidInput();
    error WrongStatus();
    error Unauthorized();
    error NotExpired();
    error VerdictAlreadyConsumed();
    error NonceAlreadyUsed();
    error InvalidVerdict();
    error InvalidTimestamp();

    event JobProposed(
        uint256 indexed jobId,
        address indexed buyer,
        address indexed provider,
        address attestor,
        bytes32 termsCommitment,
        uint256 budget,
        uint64 expiresAt
    );
    event JobAccepted(uint256 indexed jobId, address indexed provider);
    event JobCancelled(uint256 indexed jobId, address indexed buyer);
    event JobFunded(uint256 indexed jobId, address indexed buyer, uint256 budget);
    event DeliverySubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliveryCommitment);
    event JobResolved(
        uint256 indexed jobId,
        address indexed attestor,
        uint8 decision,
        bytes32 indexed verdictDigest,
        bytes32 evidenceCommitment,
        bytes32 reasonCommitment
    );
    event PaymentReleased(uint256 indexed jobId, address indexed recipient, uint256 budget);
    event JobExpired(uint256 indexed jobId, address indexed buyer, uint256 budget);

    constructor(address token, address registry, uint64 verdictLifetime) EIP712("XYX Delivery", "1") {
        if (token.code.length == 0 || registry.code.length == 0 || verdictLifetime == 0) revert InvalidConfiguration();
        paymentToken = IERC20(token);
        passkeyRegistry = XYXPasskeyRegistry(registry);
        maxVerdictLifetime = verdictLifetime;
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _job(jobId);
    }

    function proposeJob(
        address provider,
        address attestor,
        bytes32 termsCommitment,
        uint256 budget,
        uint64 expiresAt
    ) external returns (uint256 jobId) {
        if (
            provider == address(0) || attestor == address(0) || provider == msg.sender || attestor == msg.sender
                || provider == attestor || termsCommitment == bytes32(0) || budget == 0 || expiresAt <= block.timestamp
        ) revert InvalidInput();

        jobId = ++jobCounter;
        jobs[jobId] = Job({
            buyer: msg.sender,
            provider: provider,
            attestor: attestor,
            termsCommitment: termsCommitment,
            deliveryCommitment: bytes32(0),
            budget: budget,
            expiresAt: expiresAt,
            status: JobStatus.Proposed
        });
        emit JobProposed(jobId, msg.sender, provider, attestor, termsCommitment, budget, expiresAt);
    }

    function acceptJob(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Proposed || block.timestamp >= job.expiresAt) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        job.status = JobStatus.Accepted;
        emit JobAccepted(jobId, msg.sender);
    }

    function cancelProposal(uint256 jobId) external {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Proposed) revert WrongStatus();
        if (msg.sender != job.buyer) revert Unauthorized();
        job.status = JobStatus.Cancelled;
        emit JobCancelled(jobId, msg.sender);
    }

    function fundJob(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Accepted || block.timestamp >= job.expiresAt) revert WrongStatus();
        if (msg.sender != job.buyer) revert Unauthorized();
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        job.status = JobStatus.Funded;
        emit JobFunded(jobId, msg.sender, job.budget);
    }

    function submitDelivery(uint256 jobId, bytes32 deliveryCommitment) external {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded || block.timestamp >= job.expiresAt) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (deliveryCommitment == bytes32(0)) revert InvalidInput();
        job.deliveryCommitment = deliveryCommitment;
        job.status = JobStatus.Submitted;
        emit DeliverySubmitted(jobId, msg.sender, deliveryCommitment);
    }

    function hashVerdict(JobVerdict calldata verdict) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, verdict)));
    }

    function resolveJob(JobVerdict calldata verdict, WebAuthn.WebAuthnAuth calldata assertion) external nonReentrant {
        Job storage job = _job(verdict.jobId);
        if (job.status != JobStatus.Submitted || block.timestamp >= job.expiresAt) revert WrongStatus();
        if (msg.sender != job.attestor) revert Unauthorized();
        if (
            verdict.decision != 1 && verdict.decision != 2 || verdict.termsCommitment != job.termsCommitment
                || verdict.deliveryCommitment != job.deliveryCommitment || verdict.evidenceCommitment == bytes32(0)
                || verdict.reasonCommitment == bytes32(0)
        ) revert InvalidVerdict();
        if (
            verdict.issuedAt > block.timestamp || verdict.expiresAt <= block.timestamp || verdict.expiresAt <= verdict.issuedAt
                || verdict.expiresAt > job.expiresAt || verdict.expiresAt - verdict.issuedAt > maxVerdictLifetime
        ) revert InvalidTimestamp();

        bytes32 digest = hashVerdict(verdict);
        if (consumedVerdicts[digest]) revert VerdictAlreadyConsumed();
        if (usedNonces[msg.sender][verdict.nonce]) revert NonceAlreadyUsed();

        // Validate passkey assertion BEFORE marking digest/nonce consumed.
        // A registry/verifier failure must not permanently burn replay markers.
        passkeyRegistry.consumeAssertion(msg.sender, digest, assertion);

        address recipient = verdict.decision == 1 ? job.provider : job.buyer;
        paymentToken.safeTransfer(recipient, job.budget);

        // Mark digest/nonce consumed only after all external calls succeed.
        consumedVerdicts[digest] = true;
        usedNonces[msg.sender][verdict.nonce] = true;

        job.status = verdict.decision == 1 ? JobStatus.Completed : JobStatus.Rejected;
        emit JobResolved(
            verdict.jobId,
            msg.sender,
            verdict.decision,
            digest,
            verdict.evidenceCommitment,
            verdict.reasonCommitment
        );
        emit PaymentReleased(verdict.jobId, recipient, job.budget);
    }

    function claimExpiryRefund(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiresAt) revert NotExpired();
        address buyer = job.buyer;
        uint256 budget = job.budget;
        paymentToken.safeTransfer(buyer, budget);
        job.status = JobStatus.Expired;
        emit JobExpired(jobId, buyer, budget);
        emit PaymentReleased(jobId, buyer, budget);
    }

    function _job(uint256 jobId) private view returns (Job storage job) {
        if (jobId == 0 || jobId > jobCounter) revert InvalidJob();
        job = jobs[jobId];
    }
}
