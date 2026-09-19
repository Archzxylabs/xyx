// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {AgenticCommerce} from "../src/AgenticCommerce.sol";
import {XYXEvaluator} from "../src/XYXEvaluator.sol";

contract Deploy is Script {
    function run() external returns (AgenticCommerce commerce, XYXEvaluator evaluator) {
        require(block.chainid == 10143, "WRONG_MONAD_TESTNET_CHAIN");
        address token = vm.envAddress("MONAD_USDC_ADDRESS");
        address admin = vm.envAddress("XYX_ADMIN");
        address attestor = vm.envAddress("XYX_EVALUATOR_ATTESTOR");
        address pauser = vm.envAddress("XYX_PAUSER");
        uint256 lifetime = vm.envUint("VERDICT_LIFETIME");
        require(token.code.length > 0 && admin != address(0) && attestor != address(0)
            && pauser != address(0) && lifetime > 0 && lifetime <= type(uint64).max, "INVALID_DEPLOYMENT_INPUT");
        vm.startBroadcast();
        commerce = new AgenticCommerce(token);
        evaluator = new XYXEvaluator(admin, attestor, pauser, address(commerce), uint64(lifetime));
        vm.stopBroadcast();
        require(address(commerce).code.length > 0 && address(evaluator).code.length > 0, "DEPLOYMENT_FAILED");
    }
}
