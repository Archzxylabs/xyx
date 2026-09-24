# XYX Implementer Source Pack

This source pack is mandatory reading for every XYX implementer. It prevents the common failure mode of building against stale Monad assumptions or the repository's legacy public-payout code.

## 1. Authority order

Resolve a conflict in this order:

1. [Canonical XYX PRD](../XYX_MONAD_PRD.md)
2. [Architecture blueprint and evidence register](../XYX_MONAD_BLUEPRINT.md)
3. [Workstreams](../XYX_IMPLEMENTATION_WORKSTREAMS.md)
4. The current canonical contract source and its tests
5. Current official Monad/Mera documentation below

Never silently choose a convenient interpretation. Record the contradiction, impact, and decision in the handoff before changing behavior.

## 2. Official external sources

| Topic | Required source | Use it for |
| --- | --- | --- |
| Monad Testnet | [Network Information — Testnet](https://docs.monad.xyz/developer-essentials/testnet) | Chain ID, RPC/explorer/faucet facts immediately before live action |
| Monad deployment | [Deploy with Foundry](https://docs.monad.xyz/guides/deploy-smart-contract/foundry) | Foundry network configuration, keystore-first deployment flow |
| Monad verification | [Verify with Foundry](https://docs.monad.xyz/guides/verify-smart-contract/foundry) | Testnet Sourcify/MonadVision verification command and explicit outcome |
| Monad gas | [Gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing) | Gas-limit charging and UI/operator estimation policy |
| Monad differences | [Differences from Ethereum](https://docs.monad.xyz/developer-essentials/differences) | Compatibility assumptions before importing Ethereum patterns |
| Monad precompiles | [Precompiles](https://docs.monad.xyz/developer-essentials/precompiles) | Native P256 availability/behavior verification before Testnet claim |
| Monad execution | [Transaction lifecycle](https://docs.monad.xyz/monad-arch/transaction-lifecycle) and [block states](https://docs.monad.xyz/monad-arch/consensus/block-states) | Finalized-read policy and dependent-action timing |
| Mera | [Mera documentation](https://mera.category.xyz/) and [Monad Mera guide](https://docs.monad.xyz/guides/mera) | PRF/passkey account model; use web APIs for this web-only repository |
| WebAuthn | [WebAuthn Level 2](https://www.w3.org/TR/webauthn-2/) | Ceremony/result/security semantics |
| OpenZeppelin helper | [OpenZeppelin WebAuthn API](https://docs.openzeppelin.com/contracts/api/utils#WebAuthn) | Understand which validations the helper performs or deliberately omits |

Do not use an address copied from this document or a tutorial as a live payment-token fact. Before any authorized broadcast read current official docs and verify code/identity/decimals on both configured RPCs.

## 3. Local canonical source map

| File | What it means |
| --- | --- |
| `AGENTS.md` | Repository safety, Testnet-only, key separation, evidence restrictions, required gates |
| `packages/contracts/foundry.toml` | Solidity version, Monad network mode, test directory/remappings |
| `packages/contracts/src/MonadP256Verifier.sol` | Production-only native P256 verifier adapter |
| `packages/contracts/src/XYXPasskeyRegistry.sol` | Credential registration/action assertion checks and consumer binding |
| `packages/contracts/src/XYXDeliveryProtocol.sol` | Canonical state machine, EIP-712 verdict, escrow settlement |
| `packages/contracts/src/interfaces/IP256Verifier.sol` | Test seam only; not a reason to deploy a mock verifier |
| `packages/contracts/test/XYXDeliveryProtocol.t.sol` | Current local passkey/lifecycle security evidence |
| `node_modules/@openzeppelin/contracts/utils/cryptography/WebAuthn.sol` | Exact `WebAuthnAuth` ABI and validations/omissions |
| `node_modules/@openzeppelin/contracts/utils/cryptography/P256.sol` | Native/fallback P256 behavior |
| `packages/contracts/lib/forge-std/src/Vm.sol` | Current Foundry P256 test cheatcodes (`signP256`, `publicKeyP256`) |
| `packages/monad/src/**` | Existing TypeScript code; legacy payout files are not canonical SDK APIs |
| `apps/web/AGENTS.md` | Required Next.js guidance before web edits |

## 4. Immutable canonical decisions

- Network is Monad Testnet only: expected chain ID is `10143`.
- Canonical deployable contracts are only `MonadP256Verifier`, `XYXPasskeyRegistry`, and `XYXDeliveryProtocol`.
- Buyer selects attestor at proposal. Provider accepts that exact attestor before buyer can fund.
- Registry is permissionless. There is no owner/admin/pauser/role allowlist, protocol fee, proxy, central resolver, generic hook, or recovery key.
- P256 WebAuthn assertion binds exact registry action challenge. The action challenge binds chain ID, registry, protocol as consumer, attestor EOA, and verdict digest.
- Mera is the web reference account layer. Its PRF output, mnemonic/seed, derived key, session, raw credential ID, and private delivery data remain memory-only/private.
- Public contract data consists of public addresses, commitments, budget, expiry, status, events, transaction hashes, and settlement. No CIDs or artifact preimages are required or permitted in canonical public evidence.
- `AgenticCommerce`, `XYXEvaluator`, old IPFS manifest, old payout verifier, and legacy `/demo` data are migration/reference material only. They cannot support canonical live claims.
- Optional sponsor integrations are deliberately not part of the implementation request.

## 5. Evidence vocabulary

| Label | Minimum proof |
| --- | --- |
| `LOCAL_TESTED` | Fresh local test/gate command output |
| `PENDING` | Transaction started; final chain state absent |
| `UNVERIFIED` | Missing/wrong config, absent receipt, unavailable proof, unverified deployment |
| `CONFLICT` | Independent authoritative reads/configuration disagree |
| `LIVE_VERIFIED` | Independently read finalized state/receipt/logs all match the public claim |

No prompt, source file, fixture, screenshot, prepared transaction, or local script output changes an evidence label by itself.
