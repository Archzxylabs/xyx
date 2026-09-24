# XYX on Monad

XYX checks an agent's on-chain work before a protected job settles. This repository targets Monad Testnet only. The canonical flow uses three contracts — `MonadP256Verifier`, `XYXPasskeyRegistry`, and `XYXDeliveryProtocol` — with WebAuthn/P256 passkey assertion binding and immutable commitments (terms, delivery, evidence, reason). Settlement outcomes are `COMPLETE` and `REJECT` by attestor verdict and `EXPIRED` by permissionless refund, which map to on-chain statuses `Completed`, `Rejected`, and `Expired`; `Cancelled` is reachable only before funding and moves no funds.

The product contract is described in [docs/XYX_MONAD_PRD.md](docs/XYX_MONAD_PRD.md). The `/demo` page shows an empty or `UNVERIFIED` state until real receipts and contract state are observed. A passing local build is not a completed public testnet demo.

The release target is an **end-to-end MVP**, not just an operator-run demo. P0 first proves three auditable Testnet outcomes; the MVP additionally requires buyer, provider, and attestor to complete the normal job lifecycle through the product using their own wallets and a real attestor passkey, with durable operation/recovery handling. The current `/demo` is a read-only audit view. The `/reference` browser flows now prepare real wallet transactions for proposal, acceptance, funding, task transfer, delivery, passkey registration, verdict, and expiry refund, and require finalized two-RPC observations before presenting success. These paths have **not** been exercised against a live deployed XYX system. Durable recovery, publicly readable evidence/manifest publication, and the three real Testnet outcomes are still open; therefore the MVP is **not complete or live** merely because local tests pass.

## Canonical overview

The canonical flow:
1. Buyer calls `proposeJob(provider, attestor, termsCommitment, budgetAtomic, expiresAt)` on `XYXDeliveryProtocol` in ABI order. The contract rejects a buyer that is also the provider or attestor, and a provider that is also the attestor. The terms commitment binds the protocol address, token, provider, attestor, budget, expiry, and the private task/policy content.
2. Provider calls `acceptJob(jobId)`, then buyer calls `fundJob(jobId)`; the escrow pulls `job.budget`. Only after the funding receipt is finalized does the provider send the USDC transfer and call `submitDelivery(jobId, deliveryCommitment)` before expiry.
3. Attestor registers a passkey credential with `XYXPasskeyRegistry`. The attestor address must come from a connected wallet — the protocol never fabricates it.
4. Attestor calls `resolveJob(verdict, assertion)` from the attestor address itself (`msg.sender == job.attestor`). The verdict is an EIP-712 `JobVerdict` bound to the passkey assertion and to the exact protocol and registry addresses; the protocol verifies the P256 signature via `MonadP256Verifier` and the registry's rp-id/counter checks. Decision `1` pays the budget to the provider; decision `2` returns it to the buyer. Both decisions revert once `job.expiresAt` has passed.
5. Or, after expiry, anyone calls `claimExpiryRefund(jobId)`. No attestor verdict is required.
6. Publish a canonical manifest (`kind: 'xyx.monad.canonical-manifest.v1'`) with `COMPLETE`, `REJECT`, or `EXPIRED` runs. Set `XYX_CANONICAL_MANIFEST_URI` and `XYX_CANONICAL_MANIFEST_HASH` for the `/demo` page.

A relayer is optional and non-canonical: it can pay gas for permissionless calls such as `claimExpiryRefund`, but it cannot call `resolveJob` unless it is that job's attestor. There are no admin, pauser, or relayer roles in `XYXDeliveryProtocol` — the contract has no pause function and no privileged owner.

The `/demo` page reads only the canonical manifest, IPFS evidence, and Monad RPC. It verifies from both RPCs byte-for-byte: receipt, event, job state, token transfer, and finalized block hash. It shows an empty or `UNVERIFIED` state until real receipts and contract state are observed. The verification badge is always separate from the manifest claim.

## Verification badge definitions

| Badge | Meaning |
| --- | --- |
| `PENDING` | On-chain action or finality not yet confirmed |
| `LIVE_VERIFIED` | All published commitments, final chain state, and escrow transfer match |
| `REJECT` | Canonical protocol rejection confirmed on-chain |
| `UNVERIFIED` | RPC/IPFS unavailable, receipt missing, data inconsistent, or job does not meet prerequisites |
| `CONFLICT` | Published data conflicts with on-chain observation |

`LIVE_VERIFIED` requires receipt finalized, correct event from the protocol contract, matching job ID, decision, evidence/reason commitments, and the expected USDC escrow transfer. `UNVERIFIED` is not a verdict against the provider.

## Build and test

Requires Node.js, dependencies installed with `npm ci`, and Foundry 1.8 or later.

```bash
npm run build:contracts
npm run test:contracts
npm test
npm run typecheck
npm run build:web
```

Only these five are local gates. `npm run readiness` is **not** in this list:
it reads `.env` and contacts live RPC endpoints, so it belongs to the preflight
step in [Preflight before deploying](#preflight-before-deploying), not to a local
build check. `npm run test:contracts:legacy` runs the retired
`AgenticCommerce`/`XYXEvaluator` suites and is not evidence about
`XYXDeliveryProtocol`; see [docs/XYX_MONAD_BLUEPRINT.md](docs/XYX_MONAD_BLUEPRINT.md)
section 12 for the canonical/legacy test split.

## Engineering workflow triage (optional, real Jev only)

The shared Codex / Claude / human workflow is documented in
[docs/XYX_AGENT_WORKFLOW.md](docs/XYX_AGENT_WORKFLOW.md). After an implementator
has run the normal gates, a sanitized local work report can be sent once to Jev
to classify the report's claim integrity and the next review lane:

```bash
npm run workflow:triage -- --input /path/to/sanitized-work-report.json
```

The command loads `TYPESAFE_API_KEY` only from the ignored
`.env.workflow.local`, calls the official TypeSafe endpoint only with a real
credential, and prints `UNAVAILABLE` when no verified response exists. It has no
mock mode, does not read the deployment `.env`, and cannot deploy, broadcast,
sign, merge, or change XYX settlement. Its result is advisory; Foundry, tests,
RPC observations, and human review remain the source of truth.

## Configure

For first-time Testnet setup, run `npm run setup:live`. It prompts for two independent **public** RPC hosts, a bare public WebAuthn RP ID, and a token candidate; it performs only read-only RPC calls and creates `.env` only if both nodes agree on chain `10143`, the token bytecode, `decimals() = 6`, and `symbol()`. It refuses to overwrite an existing `.env`, accepts no credential-bearing browser RPC URL, and never signs, deploys, broadcasts, or reads a private key. You still choose the endpoints and token candidate—XYX verifies them rather than inventing them.

The demo page requires `XYX_PROTOCOL_ADDRESS` (non-zero), `XYX_PAYMENT_TOKEN_ADDRESS` (non-zero), `XYX_RPC_URL`, `XYX_CANONICAL_MANIFEST_URI`, and `XYX_CANONICAL_MANIFEST_HASH`. Zero or malformed addresses produce the configuration-required state; no RPC client is created.

Browser components that call `readConfig` read the `NEXT_PUBLIC_`-prefixed names instead: `NEXT_PUBLIC_XYX_CHAIN_ID`, `NEXT_PUBLIC_XYX_PROTOCOL_ADDRESS`, `NEXT_PUBLIC_XYX_REGISTRY_ADDRESS`, `NEXT_PUBLIC_XYX_P256_VERIFIER_ADDRESS`, `NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS`, `NEXT_PUBLIC_XYX_RP_ID`, `NEXT_PUBLIC_XYX_RPC_URL`, and `NEXT_PUBLIC_XYX_SECONDARY_RPC_URL`. These are public values, not secret RPC credentials. The two surfaces are separate; setting one set does not configure the other. `npm run dev:web` and `npm run build:web` load the root `.env` into the web process when present.

The browser can create seven-day capability links for private terms and delivery bundles. Payloads are encrypted locally with AES-GCM; the standalone Next.js server stores only ciphertext in a real SQLite WAL database, while the decryption key remains in the URL fragment and is not sent to the API. Set `XYX_HANDOFF_DATABASE_PATH` to a backed-up persistent volume in deployed environments. Plaintext file export/import remains an explicit offline recovery path. This closes normal-path JSON editing, but it is not public IPFS evidence publication and the SQLite single-worker store is not yet the full signer/event operation journal required by the MVP.

Fund buyer and provider with MON for gas and testnet USDC. Buyer, provider, and attestor keys must be separate and never enter Git. Deployer and relayer keys, if used, must also be separate. `XYXDeliveryProtocol` deploys with no admin or pauser argument — only token, registry, and verdict lifetime.

## Preflight before deploying

Run this before any deploy command. It is read-only: it never broadcasts, never
asks for a key, and never contacts a faucet.

```bash
npm run readiness              # checks configuration + both RPC endpoints
npm run readiness -- --offline # configuration only, no RPC calls
```

`--offline` reads nothing from the chain, so it can only ever exit `1`
(`NOT_READY`); it is a configuration sanity check, never a go/no-go gate.

Exit code `0` means ready; `1` means not ready with the failure codes in the
JSON report; `2` means the harness itself errored. A ready report is **not** an
authorization to broadcast — a human still runs the deploy command explicitly.
Every report carries `authorization: "NOT_GRANTED"`.

Two **separate** RPC clients are built, one per endpoint
(`XYX_PRIMARY_RPC_URL`/`XYX_RPC_URL` and `XYX_SECONDARY_RPC_URL`), and every
chain check reads both of them and requires them to agree — same chain ID, the
same bytecode at each address, and the same `decimals()`. A run that cannot
prove it read two independently reachable nodes never reports ready: an
`--offline` run, a run missing either endpoint, or a run handed a single probe
for both labels all end in `LIVE_DUAL_RPC_PROBE_REQUIRED`, `RPC_PROBE_REUSED`
or `RPC_PROBE_PAIR_INCOMPLETE`. There is deliberately no fallback that lets one
endpoint answer for both, because nothing read from one node twice can show
that two nodes agree.

The report is a machine-readable JSON document (stable `schema`/`version`), so
it can be captured as a build artifact. The `schema` is
`xyx-deployment-readiness`; `version` is `2` for the current field contract:

```jsonc
{
  "schema": "xyx-deployment-readiness",
  "version": "2",
  "expectedChainId": 10143,
  "observedChainIds": { "primary": 10143, "secondary": 10143 }
}
```

`expectedChainId` is a constant — what this harness is built for — and is
identical on every execution path, including an `--offline` run. It is never an
observation. `observedChainIds` holds what each live endpoint actually returned
over `eth_chainId`, and each field is `null` whenever that endpoint was not
queried (offline, missing or reused probe, incomplete pair, malformed endpoint,
timeout) or its read failed. A ready report always shows both endpoints as
10143; an offline report always shows both as `null`. There is deliberately no
top-level `chainId` field, because a single field meant both things and let an
offline run print a chain ID that nothing had read.

```bash
npm run readiness > readiness-report.json
```

Failure codes are stable identifiers, so a CI gate can assert on them directly
(e.g. `CHAIN_ID_MISMATCH`, `CHAIN_ID_DISAGREEMENT`, `TOKEN_DECIMALS_MISMATCH`,
`VERIFIER_CODE_DISAGREEMENT`, `ACTOR_ADDRESS_COLLISION`,
`RPC_ENDPOINTS_IDENTICAL`, `LIVE_DUAL_RPC_PROBE_REQUIRED`,
`GAS_BUFFER_TOO_LARGE`). A full list is exported as
`READINESS_FAILURE_CODES` from `@xyx/monad`.

RPC URLs and secret-bearing environment key names are never written to the
report, so it is safe to attach to a public issue or a CI log.

## Deploy contracts

The deploy script reads exactly four variables: `MONAD_USDC_ADDRESS`,
`XYX_RP_ID`, `VERDICT_LIFETIME`, and `DEPLOY_COMMIT` (the commit being
deployed, 40 hex characters). It validates the token's live `decimals()` against
6 and refuses to run on any chain other than 10143.

There are no admin, pauser, or relayer roles in `XYXDeliveryProtocol` — the
constructor takes only the token, the passkey registry, and the verdict
lifetime, and the contract has no pause function and no privileged owner. The
`MonadP256Verifier` address is fixed in the registry constructor. Each
`proposeJob` call selects a provider and attestor; its caller becomes the buyer.
No relayer address is stored in the job. A separate relayer is optional and may
pay gas only for permissionless calls unless it is the selected attestor; see
[Canonical overview](#canonical-overview) for who may call what.

```bash
DEPLOY_COMMIT=$(git rev-parse HEAD) \
forge script packages/contracts/script/DeployXYXDelivery.s.sol:DeployXYXDelivery --root packages/contracts --rpc-url "$MONAD_RPC_URL" --account monad-deployer --broadcast
```

The deployer keystore must be separate from the buyer, provider, attestor, and
relayer keys, and must never enter Git.

Record the resulting protocol, passkey registry, and P256 verifier addresses,
then verify source and constructor arguments on the block explorer before
running any demo flow. No deployment is claimed in this repository yet.

## See also

- [docs/XYX_MONAD_PRD.md](docs/XYX_MONAD_PRD.md) — product contract, trust model, canonical flow, security
- [docs/XYX_MONAD_BLUEPRINT.md](docs/XYX_MONAD_BLUEPRINT.md) — architecture decisions, infra, verification rules
- [docs/XYX_IMPLEMENTATION_WORKSTREAMS.md](docs/XYX_IMPLEMENTATION_WORKSTREAMS.md) — ordered build backlog and acceptance criteria

## Legacy / archive

The retired `scripts/monad-demo.ts` and `scripts/publish-manifest.ts` scripts are intentionally non-functional (`LEGACY_SCRIPT_RETIRED`). They reference the old `AgenticCommerce` / `XYXEvaluator` contract flow, evaluator roles, old IPFS payout manifest format, and legacy CLI commands. Do not use them for canonical evidence. They appear only here as historical reference.
