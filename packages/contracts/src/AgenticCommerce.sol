// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Minimal ERC-8183 job escrow for XYX's Monad testnet pilot.
/// @dev No hooks, fees, upgradeability, or privileged settlement path.
contract AgenticCommerce is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }
    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    IERC20 public immutable paymentToken;
    uint256 public jobCounter;
    mapping(uint256 => Job) private jobs;
    mapping(uint256 => bytes32) public deliverables;
    mapping(uint256 => uint256) public fundedAtBlock;
    mapping(uint256 => uint256) public submittedAtBlock;
    // Provider-scoped to prevent another provider reserving a victim's hash.
    // A hash stays reserved even when its job is rejected or expires.
    mapping(address => mapping(bytes32 => uint256)) public deliverableJob;

    error InvalidJob();
    error WrongStatus();
    error Unauthorized();
    error InvalidInput();
    error BudgetMismatch();
    error NotExpired();
    error DeliverableAlreadyUsed();

    event JobCreated(uint256 indexed jobId, address indexed client, address indexed provider, address evaluator, uint256 expiredAt, address hook);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    constructor(address token) {
        if (token.code.length == 0) revert InvalidInput();
        paymentToken = IERC20(token);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        if (jobId == 0 || jobId > jobCounter) revert InvalidJob();
        return jobs[jobId];
    }

    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external returns (uint256 jobId)
    {
        if (provider == address(0) || evaluator == address(0) || hook != address(0)
            || expiredAt <= block.timestamp || bytes(description).length == 0) revert InvalidInput();
        jobId = ++jobCounter;
        jobs[jobId] = Job(jobId, msg.sender, provider, evaluator, description, 0, expiredAt, JobStatus.Open, address(0));
        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, address(0));
    }

    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open) revert WrongStatus();
        if (msg.sender != job.client && msg.sender != job.provider) revert Unauthorized();
        if (amount == 0 || optParams.length != 0) revert InvalidInput();
        job.budget = amount;
        emit BudgetSet(jobId, amount);
    }

    function fund(uint256 jobId, uint256 expectedBudget, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open || block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.client) revert Unauthorized();
        if (job.budget == 0 || job.budget != expectedBudget || optParams.length != 0) revert BudgetMismatch();
        job.status = JobStatus.Funded;
        fundedAtBlock[jobId] = block.number;
        paymentToken.safeTransferFrom(msg.sender, address(this), job.budget);
        emit JobFunded(jobId, msg.sender, job.budget);
    }

    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded || block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.provider) revert Unauthorized();
        if (deliverable == bytes32(0) || optParams.length != 0) revert InvalidInput();
        if (deliverableJob[msg.sender][deliverable] != 0) revert DeliverableAlreadyUsed();
        job.status = JobStatus.Submitted;
        deliverables[jobId] = deliverable;
        submittedAtBlock[jobId] = block.number;
        deliverableJob[msg.sender][deliverable] = jobId;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Submitted || block.timestamp >= job.expiredAt) revert WrongStatus();
        if (msg.sender != job.evaluator) revert Unauthorized();
        if (optParams.length != 0) revert InvalidInput();
        job.status = JobStatus.Completed;
        paymentToken.safeTransfer(job.provider, job.budget);
        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Open && job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        // A funded job has one post-expiry terminal path: permissionless refund.
        if (job.status != JobStatus.Open && block.timestamp >= job.expiredAt) revert WrongStatus();
        if (job.status == JobStatus.Open ? msg.sender != job.client : msg.sender != job.evaluator) revert Unauthorized();
        if (optParams.length != 0) revert InvalidInput();
        bool funded = job.status != JobStatus.Open;
        job.status = JobStatus.Rejected;
        if (funded) {
            paymentToken.safeTransfer(job.client, job.budget);
            emit Refunded(jobId, job.client, job.budget);
        }
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _job(jobId);
        if (job.status != JobStatus.Funded && job.status != JobStatus.Submitted) revert WrongStatus();
        if (block.timestamp < job.expiredAt) revert NotExpired();
        job.status = JobStatus.Expired;
        paymentToken.safeTransfer(job.client, job.budget);
        emit JobExpired(jobId);
        emit Refunded(jobId, job.client, job.budget);
    }

    function _job(uint256 jobId) private view returns (Job storage job) {
        if (jobId == 0 || jobId > jobCounter) revert InvalidJob();
        job = jobs[jobId];
    }
}
