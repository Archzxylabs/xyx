// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";
import {IP256Verifier} from "./interfaces/IP256Verifier.sol";

/// @notice Permissionless registry binding one P256 WebAuthn credential to an EVM account.
/// @dev Credential IDs are committed, not published. The passkey assertion is bound to the consumer contract,
/// which prevents a copied assertion from being consumed by an arbitrary external caller.
contract XYXPasskeyRegistry {
    bytes32 public constant REGISTRATION_TYPEHASH =
        keccak256("XYXPasskeyRegistration(uint256 chainId,address registry,address owner,bytes32 credentialIdCommitment,bytes32 qx,bytes32 qy)");
    bytes32 public constant ACTION_TYPEHASH =
        keccak256("XYXPasskeyAction(uint256 chainId,address consumer,address owner,bytes32 actionDigest)");

    struct Credential {
        bytes32 credentialIdCommitment;
        bytes32 qx;
        bytes32 qy;
        uint32 signCount;
        bool exists;
    }

    bytes32 public immutable rpIdHash;
    IP256Verifier public immutable p256Verifier;
    mapping(address => Credential) private credentials;

    error InvalidConfiguration();
    error CredentialAlreadyRegistered();
    error CredentialNotRegistered();
    error InvalidAssertion();
    error InvalidRpIdHash();
    error InvalidSignatureCounter();

    event CredentialRegistered(address indexed owner, bytes32 indexed credentialIdCommitment, bytes32 qx, bytes32 qy);
    event AssertionConsumed(address indexed owner, address indexed consumer, bytes32 indexed actionDigest, uint32 signCount);

    constructor(bytes32 expectedRpIdHash, address verifier) {
        if (expectedRpIdHash == bytes32(0) || verifier.code.length == 0) revert InvalidConfiguration();
        rpIdHash = expectedRpIdHash;
        p256Verifier = IP256Verifier(verifier);
    }

    function credentialOf(address owner) external view returns (Credential memory) {
        return credentials[owner];
    }

    function registrationChallenge(address owner, bytes32 credentialIdCommitment, bytes32 qx, bytes32 qy)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(REGISTRATION_TYPEHASH, block.chainid, address(this), owner, credentialIdCommitment, qx, qy)
        );
    }

    function assertionChallenge(address consumer, address owner, bytes32 actionDigest) public view returns (bytes32) {
        return keccak256(abi.encode(ACTION_TYPEHASH, block.chainid, consumer, owner, actionDigest));
    }

    function registerCredential(
        bytes32 credentialIdCommitment,
        bytes32 qx,
        bytes32 qy,
        WebAuthn.WebAuthnAuth calldata assertion
    ) external {
        if (credentials[msg.sender].exists) revert CredentialAlreadyRegistered();
        if (credentialIdCommitment == bytes32(0) || qx == bytes32(0) || qy == bytes32(0)) revert InvalidConfiguration();

        uint32 counter = _verify(
            credentialIdCommitment,
            qx,
            qy,
            registrationChallenge(msg.sender, credentialIdCommitment, qx, qy),
            assertion,
            0
        );
        credentials[msg.sender] = Credential({
            credentialIdCommitment: credentialIdCommitment,
            qx: qx,
            qy: qy,
            signCount: counter,
            exists: true
        });
        emit CredentialRegistered(msg.sender, credentialIdCommitment, qx, qy);
    }

    /// @notice Verifies an assertion for msg.sender as the consumer contract and updates its sign counter.
    function consumeAssertion(address owner, bytes32 actionDigest, WebAuthn.WebAuthnAuth calldata assertion) external {
        Credential storage credential = credentials[owner];
        if (!credential.exists) revert CredentialNotRegistered();

        uint32 counter = _verify(
            credential.credentialIdCommitment,
            credential.qx,
            credential.qy,
            assertionChallenge(msg.sender, owner, actionDigest),
            assertion,
            credential.signCount
        );
        credential.signCount = counter;
        emit AssertionConsumed(owner, msg.sender, actionDigest, counter);
    }

    function _verify(
        bytes32,
        bytes32 qx,
        bytes32 qy,
        bytes32 challenge,
        WebAuthn.WebAuthnAuth calldata assertion,
        uint32 previousCounter
    ) private view returns (uint32 counter) {
        if (assertion.authenticatorData.length < 37) revert InvalidAssertion();
        bytes calldata authenticatorData = assertion.authenticatorData;
        bytes32 observedRpIdHash;
        assembly ("memory-safe") {
            observedRpIdHash := calldataload(authenticatorData.offset)
        }
        if (observedRpIdHash != rpIdHash) revert InvalidRpIdHash();

        // OpenZeppelin validates WebAuthn type, challenge, UP, UV, backup flags, and P256 validity.
        if (!WebAuthn.verify(abi.encodePacked(challenge), assertion, qx, qy)) revert InvalidAssertion();

        bytes32 signatureHash = sha256(abi.encodePacked(assertion.authenticatorData, sha256(bytes(assertion.clientDataJSON))));
        // A second check forces the production path through Monad's native precompile.
        if (!p256Verifier.verify(signatureHash, assertion.r, assertion.s, qx, qy)) revert InvalidAssertion();

        counter = uint32(bytes4(assertion.authenticatorData[33:37]));
        // Synced passkeys commonly report zero. When a counter is available, it must advance.
        if ((previousCounter != 0 || counter != 0) && counter <= previousCounter) revert InvalidSignatureCounter();
    }
}
