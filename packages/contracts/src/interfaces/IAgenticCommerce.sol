// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @dev Minimal interface required by XYXEvaluator for job settlement.
interface IAgenticCommerce {
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
