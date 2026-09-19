# XYX on Monad

XYX checks an agent's on-chain work before a protected job settles. This repository contains a Monad Testnet pilot: the buyer escrows USDC, the provider sends a specified USDC payout, and an independent verifier checks the transfer receipt before the evaluator releases or refunds the reward.

The product contract is described in [docs/XYX_MONAD_PRD.md](docs/XYX_MONAD_PRD.md). The first demo is visible at `/demo`. It does not invent live transactions; an empty page means no testnet run has been completed.

See [the implementation audit and development blueprint](docs/XYX_MONAD_BLUEPRINT.md) for verified local status, remaining gaps, the product's trust and economic limits, infrastructure choices, and the ordered build backlog. For issue-ready ownership, merge order, and the release gate, use the [implementation workstreams](docs/XYX_IMPLEMENTATION_WORKSTREAMS.md). A passing local build is not a completed public testnet demo.

## Build and test

Requires Node.js, dependencies installed with `npm ci`, and Foundry 1.8 or later.

```bash
npm run build:contracts
npm run test:contracts
npm test
npm run typecheck
npm run build:web
```

## Configure

Copy `.env.example` to a local `.env`. Set a primary and independent secondary Monad Testnet RPC, then separate testnet wallets for buyer, provider, evaluator attestor, and relayer. Never use a mainnet key. Fund buyer and provider with MON for gas and testnet USDC. The demo CLI validates chain ID and USDC decimals before actions; verdicts and manifest publishing require both RPCs to agree on finalized data.

The default USDC address in `.env.example` comes from [Monad's x402 guide](https://docs.monad.xyz/guides/x402). Confirm contract code and token identity on your chosen RPC before funding. Foundry deployment uses the [Monad execution environment](https://docs.monad.xyz/guides/deploy-smart-contract/foundry).

Run a Kubo IPFS node locally or configure Pinata. `compose.yaml` starts a local Kubo node.

## Deploy contracts

Set `XYX_ADMIN`, `XYX_EVALUATOR_ATTESTOR`, `XYX_PAUSER`, `MONAD_USDC_ADDRESS`, and `VERDICT_LIFETIME`. The evaluator attestor address must equal the address derived from `MONAD_EVALUATOR_PRIVATE_KEY`. The deployer uses a separate keystore.

```bash
forge script packages/contracts/script/Deploy.s.sol:Deploy --root packages/contracts --rpc-url "$MONAD_RPC_URL" --account monad-deployer --broadcast
```

Record the resulting commerce and evaluator addresses as `MONAD_COMMERCE_ADDRESS` and `MONAD_EVALUATOR_ADDRESS`. Verify source and constructor arguments on MonadVision before running the demo. No deployment is claimed in this repository yet.

## Run the three demo cases

`demo-runs/` is local operational state and is Git ignored. Run names identify distinct jobs. Each command waits for an on-chain receipt; if a command ends ambiguously, inspect the wallet and chain before retrying.

```bash
node --env-file=.env --import tsx scripts/monad-demo.ts prepare good 0xRECIPIENT
node --env-file=.env --import tsx scripts/monad-demo.ts create good
node --env-file=.env --import tsx scripts/monad-demo.ts budget good
node --env-file=.env --import tsx scripts/monad-demo.ts fund good
node --env-file=.env --import tsx scripts/monad-demo.ts execute good
node --env-file=.env --import tsx scripts/monad-demo.ts evaluate good
```

Repeat with run name `bad` and `execute bad wrong` to demonstrate REJECT. For `expired`, stop after `fund`, wait until the committed expiry, then run `refund expired`. The default expiry is 15 minutes; set `MONAD_DEMO_EXPIRY_SECONDS=300` before `prepare expired` for a five-minute expiry run. Start the UI with `npm run dev:web` and open `/demo`; it reads a published manifest, IPFS evidence, and Monad RPC.

If the normal operator journal, IPFS, or attestor is unavailable after expiry, use the recovery command with only the relayer key, commerce address, RPC, and job ID. It prints the signed transaction hash before broadcast; reconcile that hash before attempting another refund.

```bash
npm run claim:refund -- 123 expired
```

The optional run name atomically records the refund hash before broadcast, so the later manifest can include it. Without a run name, retain the printed hash and reconcile it on-chain before any retry.

After all final testnet runs are reconciled, publish their public manifest from the operator machine. The publisher recomputes payout/settlement evidence against both RPCs before upload. Set the printed URI and hash, plus a public IPFS gateway URL and both RPC URLs, in the web deployment environment. The public page reads only this manifest and the referenced IPFS evidence; it does not read the operator journal.

```bash
npm run publish:manifest
```

P0 uses a minimal non-upgradeable ERC-8183-compatible escrow implementation based on the [draft ERC-8183 specification](https://eips.ethereum.org/EIPS/eip-8183). It is not the upstream upgradeable reference contract and needs independent security review before production use.
