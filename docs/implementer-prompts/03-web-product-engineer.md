# Prompt — XYX Web Reference Engineer

```text
You are the web reference engineer for XYX in:

/home/pupulion/xyx-monad

Read AGENTS.md, docs/XYX_MONAD_PRD.md, docs/XYX_MONAD_BLUEPRINT.md, docs/XYX_IMPLEMENTATION_WORKSTREAMS.md, docs/implementer-prompts/README.md, docs/implementer-prompts/SOURCES.md, and apps/web/AGENTS.md before editing. Follow the Next.js instructions in apps/web/AGENTS.md, including reading applicable installed Next documentation before writing application code. Inspect git status/diff and packages/monad public APIs first.

XYX is a developer-facing private AI delivery-attestation reference. It is not a mockup, consumer marketplace, central verifier console, or a visual rewrite of the legacy public payout demo.

Build a browser-only integration surface around the canonical SDK and contracts. Do not duplicate commitment logic or WebAuthn parsing in React components.

Required product behavior:
1. Configuration gate: require valid public protocol/registry/native-verifier addresses, RP ID, Testnet chain/RPC configuration, and verified chain context. Missing or invalid config disables sensitive controls and explains why.
2. Explain the boundary: private terms/delivery/evidence never enter chain; buyer chooses attestor; provider accepts before funding; attestor judgment is trusted; final settlement is irreversible; expiry refunds buyer reward only.
3. Buyer flow previews commitment, provider/attestor, payment token/budget, and expiry before proposal/funding.
4. Provider flow reads selected attestor, explicitly accepts before buyer can fund, and submits only a delivery commitment.
5. Attestor flow creates/registers passkey credential without rendering raw credential/PRF material; preview valid verdict fields and deadline; requires UV+PRF action ceremony bound to exact verdict before resolve transaction.
6. Expiry flow appears only after confirmed on-chain eligible state/time.
7. Transaction UX distinguishes draft, browser prompt, submitted, pending, finalized, user cancellation, revert, unverified, and conflict. Use finalized independent reads before any settled success copy.
8. All status/error communication is accessible: words as well as color, clear focus order, labelled explorer links, disabled reasons, and error recovery instructions.
9. `/demo` stays read-only and empty or UNVERIFIED until a real canonical deployment plus real finalized chain evidence is independently read. Never display legacy IPFS/manifest fixtures as the new protocol.

Security/privacy rules:
- No raw task input/output/evidence, credential ID, PRF output, seed, key, session, RPC credential, source-verifier key, or signed transaction reaches browser persistence, console, analytics, URLs, props rendered to HTML, or error telemetry.
- Browser-only WebAuthn/Mera code must not be imported by a server-rendered module.
- Do not hard-code live addresses or call a contract deployed/verified unless public configuration and confirmed chain data prove it.
- Do not add Envio, x402, ERC-8004, C2PA/IPFS, mobile, worker/backend, authentication service, marketplace, or optional sponsor integration.

Before implementation, produce an alignment table: screen/control, PRD requirement, SDK data/action, private/public classification, failure state, and proof level. Run npm run typecheck and npm run build:web. For release-ready handoff run all gates and report exact output. State honestly what remains local-only.

## Sources and design inputs

Read `SOURCES.md` and the installed Next guidance required by `apps/web/AGENTS.md`. The source of truth for protocol terms is the PRD; component behavior comes from canonical SDK exports, never from the legacy `payout.ts`/manifest schema. Do not introduce a public payment-token address or an explorer URL as a source-code fact. Configuration is public only after it has passed runtime validation and actual chain reads.

## Required route and component plan

Implement the smallest clear surface; do not create a dashboard with invented metrics. Suggested file placement is below, but adapt to the repository's installed Next conventions after reading its instructions:

| Route/component | Purpose | Sensitive-data rule |
| --- | --- | --- |
| `/` or `/reference` | Product explanation, configuration state, role entry points | No private input persisted/rendered before user action |
| `ProtocolConfigurationGate` | Parses public env/config and confirms chain/readiness | Public addresses/RP ID only; no RPC credential or secret fallback |
| `BuyerJobForm` | Terms commitment preview, provider/attestor/budget/expiry, propose/fund steps | Raw terms and salt remain in component memory; only commitment is displayed/sent |
| `ProviderAcceptancePanel` | Reads job, shows selected attestor, accepts, submits delivery commitment | Raw delivery/salt stay in memory |
| `AttestorPasskeyPanel` | Register credential / build verdict / perform one action ceremony | Never render/store raw credential ID, PRF output, seed, key, or assertion blob |
| `JobStatePanel` | Confirmed lifecycle/event/receipt status and next valid action | Uses canonical contract reads, not mutable local form status |
| `ExpiryRefundPanel` | Shows only eligible chain-confirmed expiry action | No dependency on attestor/private evidence |
| `/demo` | Read-only public audit boundary | Empty/unverified unless canonical finalized evidence exists |

Do not require that these be separate routes if a smaller well-factored route is clearer. The user must be able to tell which actions are reference-only/unavailable because configuration or Testnet proof is missing.

## Configuration contract

Use explicit public names (or a documented configuration module) for:

```text
NEXT_PUBLIC_XYX_CHAIN_ID=10143
NEXT_PUBLIC_XYX_PROTOCOL_ADDRESS=0x...
NEXT_PUBLIC_XYX_REGISTRY_ADDRESS=0x...
NEXT_PUBLIC_XYX_P256_VERIFIER_ADDRESS=0x...
NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS=0x...  # optional until deployment; required before funding UI
NEXT_PUBLIC_XYX_RP_ID=app.example.com
NEXT_PUBLIC_XYX_RPC_URL=https://...           # public/read-only endpoint only
```

At boot, validate numeric/address/RP syntax and require secure browser context for passkey actions. Before mutation, the client asks the configured RPC for chain ID and validates deployed bytecode/read-only immutable bindings. If any configuration item is absent, malformed, wrong-chain, code-less, inconsistent, or cannot be confirmed, render an `UNVERIFIED` configuration card; disable mutations; and show which exact prerequisite is absent. Never silently replace a missing address with legacy config, a hard-coded sample, or an arbitrary wallet network.

Because environment variables are baked into client bundles, treat every `NEXT_PUBLIC_*` value as public. Never name a secret with this prefix. The product must function in a safe read-only/no-config state during CI and static build.

## Detailed user flows

### Buyer

1. User enters private terms only in client memory and selects provider/attestor EOAs, token/budget, expiry.
2. SDK validates pairwise-distinct accounts, allowed deadline, `10143`, and terms binding fields; generates/provides a high-entropy salt; displays only commitment and safe field summary.
3. UI asks user to confirm proposed transaction. After wallet result, show `PENDING` with hash; then query receipt and canonical job state. Do not show funded/proposed from a successful signature alone.
4. Funding controls remain disabled until a confirmed job is `Accepted`, caller is buyer, deadline has not passed, token binding is confirmed, allowance is sufficient, and gas estimate/buffer is shown. Approval and funding are separate explicit actions.

### Provider

1. UI reads the canonical job by ID and shows buyer, selected attestor, public terms commitment, budget, expiry, and status.
2. Provider must explicitly accept. Explain this chooses the attestor for later private review and is irrevocable for the funded job.
3. Only confirmed `Funded` state enables delivery commitment submission. Local raw delivery and salt produce one displayed commitment; do not upload/dump them.

### Attestor

1. Explain that attestor sees/reviews private material outside the public app and must never paste it into the page.
2. Registration validates secure context, RP ID, ES256, resident credential, PRF, and user verification. Expose only public credential commitment and P256 key after validation.
3. Resolution reads job/registry/protocol state, verifies attestor EOA matches job, verifies deadline/lifetime, accepts only private commitment fields, asks SDK to obtain `hashVerdict`/action challenge, then invokes the action ceremony.
4. Display user cancellation distinct from browser capability failure, on-chain revert, and receipt pending. Always zero sensitive material through SDK cleanup regardless of result.

### Expiry caller

Show expiry refund only after the chain read confirms `Funded`/`Submitted` and current finalized chain timestamp reaches the stored expiry. State that refund pays buyer and does not reverse any external/private delivery exchange.

## State and accessibility contract

Use this text status mapping consistently:

| UI state | Meaning | Allowed call to action |
| --- | --- | --- |
| `CONFIGURATION_REQUIRED` | Required public config unavailable | Explain missing keys; no transaction control |
| `WRONG_NETWORK` | RPC/wallet chain is not 10143 | Switch/reconfigure, then re-read |
| `READY` | Preconditions confirmed, no action submitted | Present exact next action |
| `AWAITING_PASSKEY` | Browser ceremony requested | Cancel/retry only |
| `SUBMITTED` | Transaction hash exists, final result absent | Link explorer, await receipt |
| `PENDING_FINALITY` | Receipt/state not yet final | Re-read; no success claim |
| `FINALIZED` | Receipt and state match | Show public facts, not private material |
| `UNVERIFIED` | Required fact unavailable | Explain source/fact missing |
| `CONFLICT` | Sources or state disagree | Stop action and report discrepancy |
| `FAILED` | User cancelled/reverted/invalid proof | Give safe recovery step |

Every state has text, not color alone. Use semantic headings, labelled form controls, error summaries, keyboard focus management after errors, `aria-live` for transaction state changes, non-truncated accessible address/hash labels, and explorer links that identify target/action. Avoid copied “LIVE”, “protected”, “verified”, or “success” language unless the status table permits it.

## Privacy and observability review

Before handoff run `rg` over web code for `console.`, `localStorage`, `sessionStorage`, `JSON.stringify`, query-param creation, analytics/telemetry, error reporter, `credential`, `prf`, `seed`, `privateKey`, `prompt`, `evidence`, `delivery`, `IPFS`, `LIVE`, and `VERIFIED`. Explain every allowed occurrence. Confirm that browser-only Mera/WebAuthn imports occur behind a client boundary and that static/server build with no browser globals succeeds.

## Definition of done

Deliver screenshots only as supplementary design evidence, never proof of chain behavior. Include route/component map, configuration schema, status matrix, privacy scan result, exact build/typecheck/gate output, and an explicit statement that the UI remains local/unverified until canonical Testnet data exists.
```
