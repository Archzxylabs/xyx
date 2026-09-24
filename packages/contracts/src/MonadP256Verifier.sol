// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {IP256Verifier} from "./interfaces/IP256Verifier.sol";

/// @notice Production P256 verifier for Monad.
/// @dev verifyNative reverts if Monad's 0x0100 precompile is not available; it never falls back to Solidity.
contract MonadP256Verifier is IP256Verifier {
    function verify(bytes32 hash, bytes32 r, bytes32 s, bytes32 qx, bytes32 qy) external view returns (bool) {
        return P256.verifyNative(hash, r, s, qx, qy);
    }
}
