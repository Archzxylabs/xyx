// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Minimal seam for testing the Monad-native P256 verifier.
/// @dev Production deployments use MonadP256Verifier; tests may inject a deterministic mock.
interface IP256Verifier {
    function verify(bytes32 hash, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) external view returns (bool);
}
