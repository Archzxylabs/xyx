// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IAgenticCommerce} from "./interfaces/IAgenticCommerce.sol";

/// @notice Authorizes a verdict; the ERC-8183 escrow owns job state and settlement.
contract XYXEvaluator is AccessControl, Pausable, ReentrancyGuard, EIP712 {
    bytes32 public constant ATTESTOR_ROLE = keccak256("ATTESTOR_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant VERDICT_TYPEHASH = keccak256("JobVerdict(uint256 jobId,bytes32 evidenceHash,bytes32 reasonHash,uint8 decision,uint64 issuedAt,uint64 expiresAt,uint64 nonce)");
    IAgenticCommerce public immutable agenticCommerce;
    uint64 public immutable maxVerdictLifetime;
    mapping(bytes32 => bool) public consumed;
    mapping(address => mapping(uint64 => bool)) public usedNonces;

    struct JobVerdict {
        uint256 jobId;
        bytes32 evidenceHash;
        bytes32 reasonHash;
        uint8 decision;
        uint64 issuedAt;
        uint64 expiresAt;
        uint64 nonce;
    }

    error InvalidConfiguration();
    error InvalidVerdict();
    error InvalidTimestamp();
    error VerdictAlreadyConsumed();
    error NonceAlreadyUsed();
    event JobVerdictExecuted(bytes32 indexed verdictHash, uint256 indexed jobId, uint8 decision,
        bytes32 evidenceHash, bytes32 reasonHash, address indexed attestor);

    constructor(address admin, address attestor, address pauser, address commerce, uint64 lifetime)
        EIP712("XYX Evaluator", "1")
    {
        if (admin == address(0) || attestor == address(0) || pauser == address(0)
            || commerce.code.length == 0 || lifetime == 0) revert InvalidConfiguration();
        agenticCommerce = IAgenticCommerce(commerce);
        maxVerdictLifetime = lifetime;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ATTESTOR_ROLE, attestor);
        _grantRole(PAUSER_ROLE, pauser);
    }

    function hashVerdict(JobVerdict calldata v) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VERDICT_TYPEHASH, v)));
    }

    function resolveJob(JobVerdict calldata v, bytes calldata signature) external nonReentrant whenNotPaused {
        bytes32 digest = hashVerdict(v);
        address signer = ECDSA.recover(digest, signature);
        _checkRole(ATTESTOR_ROLE, signer);
        if (v.decision != 1 && v.decision != 2 || v.evidenceHash == 0 || v.reasonHash == 0) revert InvalidVerdict();
        if (v.issuedAt > block.timestamp || v.expiresAt <= block.timestamp || v.expiresAt <= v.issuedAt
            || v.expiresAt - v.issuedAt > maxVerdictLifetime) revert InvalidTimestamp();
        if (consumed[digest]) revert VerdictAlreadyConsumed();
        if (usedNonces[signer][v.nonce]) revert NonceAlreadyUsed();
        consumed[digest] = true;
        usedNonces[signer][v.nonce] = true;
        emit JobVerdictExecuted(digest, v.jobId, v.decision, v.evidenceHash, v.reasonHash, signer);
        if (v.decision == 1) agenticCommerce.complete(v.jobId, v.reasonHash, bytes(""));
        else agenticCommerce.reject(v.jobId, v.reasonHash, bytes(""));
    }

    function pause() external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
}
