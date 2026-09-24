// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {MonadP256Verifier} from "../src/MonadP256Verifier.sol";
import {XYXPasskeyRegistry} from "../src/XYXPasskeyRegistry.sol";
import {XYXDeliveryProtocol} from "../src/XYXDeliveryProtocol.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Canonical deployment of the three XYX contracts on Monad Testnet (chain ID 10143).
/// @dev Deploys in dependency order: MonadP256Verifier -> XYXPasskeyRegistry -> XYXDeliveryProtocol.
///      Refuses any chain other than 10143 before broadcast. Validates token identity on-chain.
///      Uses only the DEPLOY_COMMIT environment variable; no private key material.
///
///      THIS SCRIPT DOES NOT PRODUCE DEPLOYMENT PROVENANCE.
///      A simulation, a local Foundry run, or an address predicted before
///      broadcast is not a Testnet deployment. The `DeployScriptLocalSummary`
///      event below is emitted by THIS script's OWN execution frame and is
///      therefore local script output only: it is not a receipt, not proof of
///      finality, and not deployment provenance.
///
///      Final deployment provenance is derived from actual RPC receipts,
///      runtime bytecode, and immutable bindings read from two distinct RPC
///      endpoints by `packages/contracts/script/record-xyx-delivery-provenance.sh`.
///      That tool is the only authority for a `final` provenance record.
///
/// Required environment (nonsecret):
///   MONAD_USDC_ADDRESS    - ERC-20 payment token address
///   XYX_RP_ID             - Host-only RP ID (e.g. "xyx.local")
///   VERDICT_LIFETIME      - uint64 verdict lifetime in seconds
///   DEPLOY_COMMIT         - git commit identifier for provenance
///
/// Operator execution uses a named encrypted Foundry keystore:
///   forge script script/DeployXYXDelivery.s.sol:DeployXYXDelivery \
///     --rpc-url "$PRIMARY_RPC" --account deployer-keystore --broadcast --chain 10143
contract DeployXYXDelivery is Script {
    struct DeployScriptLocalSummaryData {
        uint64 chainId;
        string commit;
        string solcVersion;
        bool optimizer;
        uint64 optimizerRuns;
        bool viaIr;
        address verifier;
        address registry;
        address protocol;
        address token;
        uint8 tokenDecimals;
        string tokenSymbol;
        uint64 maxVerdictLifetime;
        bytes32 rpIdHash;
        uint64 blockNumber;
        bytes32 blockHash;
        bytes verifierConstructorArgs;
        bytes registryConstructorArgs;
        bytes protocolConstructorArgs;
        bytes32 verifierCodeHash;
        bytes32 registryCodeHash;
        bytes32 protocolCodeHash;
    }

    /// @dev Stops on chain mismatch, missing/invalid inputs, token identity failure,
    ///      or deployment address/code failure. Never continues with warnings.
    function run()
        external
        returns (MonadP256Verifier verifier, XYXPasskeyRegistry registry, XYXDeliveryProtocol protocol)
    {
        // ── 0. Chain gate ─────────────────────────────────────────────────────
        require(block.chainid == 10143, "WRONG_CHAIN: expected 10143");

        // ── 1. Read nonsecret inputs ──────────────────────────────────────────
        address token = vm.envAddress("MONAD_USDC_ADDRESS");
        string memory rpId = vm.envString("XYX_RP_ID");
        uint256 verdictLifetimeUint = vm.envUint("VERDICT_LIFETIME");
        require(verdictLifetimeUint > 0 && verdictLifetimeUint <= type(uint64).max, "INVALID_VERDICT_LIFETIME");
        uint64 verdictLifetime = uint64(verdictLifetimeUint);
        string memory commit = vm.envString("DEPLOY_COMMIT");

        // ── 2. Basic input validation ─────────────────────────────────────────
        require(token.code.length > 0 && token != address(0), "TOKEN_INVALID");
        require(bytes(rpId).length > 0, "RP_ID_REQUIRED");
        require(bytes(commit).length > 0, "DEPLOY_COMMIT_REQUIRED");

        // Host-only RP ID: must not include path or protocol
        vm.assume(bytes(rpId).length > 0); // NOP safety; checked above
        if (indexOf(rpId, "/") >= 0 || indexOf(rpId, ":") >= 0) {
            revert("RP_ID_MUST_BE_HOST_ONLY");
        }

        bytes32 rpIdHash = sha256(bytes(rpId));

        // ── 3. Verify token identity live ─────────────────────────────────────
        // Read decimals: must be 6 for the expected stablecoin
        bytes4 decimalsSig = IERC20Metadata(token).decimals.selector;
        bytes memory decimalsData = abi.encodeWithSelector(decimalsSig);
        (bool decimalsOk, bytes memory decimalsRet) = token.call(decimalsData);
        require(decimalsOk && decimalsRet.length == 32, "TOKEN_DECIMALS_READ_FAILED");
        uint8 tokenDecimals = uint8(abi.decode(decimalsRet, (uint8)));
        require(tokenDecimals == 6, "TOKEN_WRONG_DECIMALS");

        // Read symbol: operator must confirm current official token identity
        bytes4 symbolSig = IERC20Metadata(token).symbol.selector;
        bytes memory symbolData = abi.encodeWithSelector(symbolSig);
        (bool symbolOk, bytes memory symbolRet) = token.call(symbolData);
        require(symbolOk && symbolRet.length >= 32, "TOKEN_SYMBOL_READ_FAILED");
        string memory tokenSymbol = abi.decode(symbolRet, (string));

        // ── 4. Deploy in dependency order ─────────────────────────────────────
        vm.startBroadcast();

        verifier = new MonadP256Verifier();
        registry = new XYXPasskeyRegistry(rpIdHash, address(verifier));
        protocol = new XYXDeliveryProtocol(token, address(registry), verdictLifetime);

        vm.stopBroadcast();

        // ── 5. Verify deployment addresses ────────────────────────────────────
        require(address(verifier).code.length > 0, "VERIFIER_DEPLOYMENT_FAILED");
        require(address(registry).code.length > 0, "REGISTRY_DEPLOYMENT_FAILED");
        require(address(protocol).code.length > 0, "PROTOCOL_DEPLOYMENT_FAILED");

        // ── 6. Verify immutable bindings match constructor inputs ─────────────
        require(registry.rpIdHash() == rpIdHash, "BINDING_RP_HASH_MISMATCH");
        require(address(registry.p256Verifier()) == address(verifier), "BINDING_VERIFIER_MISMATCH");
        require(address(protocol.paymentToken()) == token, "BINDING_TOKEN_MISMATCH");
        require(address(protocol.passkeyRegistry()) == address(registry), "BINDING_REGISTRY_MISMATCH");
        require(protocol.maxVerdictLifetime() == verdictLifetime, "BINDING_LIFETIME_MISMATCH");

        // ── 7. Emit a LOCAL script summary ────────────────────────────────────
        // This event describes what THIS script execution built. It is emitted
        // from the script's own frame, so it is local script output only: not a
        // receipt, not proof of finality, and not deployment provenance.
        // Provenance comes from RPC receipts and contract reads performed by
        // record-xyx-delivery-provenance.sh, never from this event.
        emit DeployScriptLocalSummary({
            chainId: uint64(block.chainid),
            commit: commit,
            solcVersion: "0.8.30",
            optimizer: true,
            optimizerRuns: 200,
            viaIr: true,
            verifier: address(verifier),
            registry: address(registry),
            protocol: address(protocol),
            token: token,
            tokenDecimals: tokenDecimals,
            tokenSymbol: tokenSymbol,
            maxVerdictLifetime: verdictLifetime,
            rpIdHash: rpIdHash,
            blockNumber: uint64(block.number),
            blockHash: blockhash(block.number),
            verifierConstructorArgs: abi.encode(""),
            registryConstructorArgs: abi.encode(rpIdHash, address(verifier)),
            protocolConstructorArgs: abi.encode(token, address(registry), verdictLifetime),
            verifierCodeHash: keccak256(address(verifier).code),
            registryCodeHash: keccak256(address(registry).code),
            protocolCodeHash: keccak256(address(protocol).code)
        });
    }

    /// @notice LOCAL SCRIPT OUTPUT ONLY — NOT DEPLOYMENT PROVENANCE.
    /// @dev Emitted by this script's own execution frame, so it cannot attest
    ///      that a transaction was broadcast, mined, or finalized. It is a
    ///      description of what the script built, for local operator review.
    ///      A `final` deployment provenance record is produced only by
    ///      record-xyx-delivery-provenance.sh from real RPC receipts and
    ///      contract reads, and no tool may treat this event as proof.
    event DeployScriptLocalSummary(
        uint64 indexed chainId,
        string commit,
        string solcVersion,
        bool optimizer,
        uint64 optimizerRuns,
        bool viaIr,
        address indexed verifier,
        address indexed registry,
        address protocol,
        address token,
        uint8 tokenDecimals,
        string tokenSymbol,
        uint64 maxVerdictLifetime,
        bytes32 rpIdHash,
        uint64 blockNumber,
        bytes32 blockHash,
        bytes verifierConstructorArgs,
        bytes registryConstructorArgs,
        bytes protocolConstructorArgs,
        bytes32 verifierCodeHash,
        bytes32 registryCodeHash,
        bytes32 protocolCodeHash
    );

    /// @dev Returns the index of `needle` in `haystack`, or -1 if not found.
    function indexOf(string memory haystack, string memory needle) internal pure returns (int256) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || n.length > h.length) return -1;
        for (uint256 i = 0; i + n.length <= h.length; i++) {
            bool found = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) { found = false; break; }
            }
            if (found) return int256(i);
        }
        return -1;
    }
}
