# XYX Implementer Prompt Pack

These are copy-ready English work briefs for the canonical XYX protocol: private AI delivery attestation on Monad Testnet. They supersede every earlier prompt that describes `AgenticCommerce`, `XYXEvaluator`, public IPFS evidence, central attestor roles, a legacy payout demo, Envio, x402, ERC-8004, or optional sponsor integrations as current requirements.

Every implementer must also read [SOURCES.md](SOURCES.md). It contains official Monad/Mera/WebAuthn sources, local source map, immutable product decisions, and evidence vocabulary. The source pack is part of each prompt, not optional background reading.

## Shared product statement

XYX lets a buyer commit private AI-work terms, select an attestor, obtain provider acceptance of that attestor, escrow a stablecoin reward, receive a private delivery commitment, and settle through a selected attestor's passkey-backed verdict. The chain reveals commitments and settlement only. It never stores prompts, delivery/evidence payloads, credential IDs, PRF output, or keys.

The canonical contracts are `MonadP256Verifier`, `XYXPasskeyRegistry`, and `XYXDeliveryProtocol`. The public browser application is a developer integration reference. `/demo` is a read-only audit surface that stays empty or unverified until real canonical Testnet receipts exist.

## Prompt order and ownership

| File | Owner | Use it for |
| --- | --- | --- |
| [00-platform-lead.md](00-platform-lead.md) | Release owner | Alignment decisions, sequencing, evidence standards |
| [01-smart-contract-engineer.md](01-smart-contract-engineer.md) | Solidity security engineer | Canonical contract ABI, tests, and security hardening |
| [02-protocol-platform-engineer.md](02-protocol-platform-engineer.md) | TypeScript protocol engineer | Commitment SDK, Mera/passkey code, strict schemas |
| [03-web-product-engineer.md](03-web-product-engineer.md) | Web engineer | Config-gated Next.js reference flow and truthful audit UI |
| [04-chain-operations-engineer.md](04-chain-operations-engineer.md) | Release/chain operations engineer | Dry preflight, deploy/verify/provenance tooling; live actions only after authorization |
| [05-hermes-remediation.md](05-hermes-remediation.md) | Audit/remediation agent | Whole-repository truth audit and bounded fixes |
| [06-provider-runner-security-remediation.md](06-provider-runner-security-remediation.md) | Provider-runner implementation owner | Repair recovery evidence, error privacy, preflight ordering, and known-hash reconciliation |
| [07-provider-runner-adversarial-review.md](07-provider-runner-adversarial-review.md) | Independent test/review owner | After the remediation checkpoint, add adversarial regression tests without editing production source |
| [08-jev-build-supervisor.md](08-jev-build-supervisor.md) | Codex/release-owner supervisor | Inspect checkpoints, run real Jev supervision, and return bounded correction packets to implementers |
| [SOURCES.md](SOURCES.md) | Every owner | Official source links, local source map, decision and evidence glossary |

## Provider-runner remediation sequencing

Prompts 06 and 07 are deliberately sequential. Do not run them in parallel.

1. The release owner records an exact reviewed baseline SHA that already contains the current provider-runner files. Untracked files are not a usable shared baseline.
2. Prompt 06 exclusively owns the provider-runner source and existing provider-runner tests. No other implementer edits those paths during remediation.
3. The release owner or Codex follows Prompt 08, independently inspects Prompt 06's diff/gates, runs `workflow:supervise`, and returns every correction packet to Prompt 06 until the effective action is `START_REVIEWER_07`.
4. The release owner reviews the accepted Prompt 06 diff and gate output, then creates or identifies a remediation checkpoint SHA.
5. Prompt 07 starts from that exact SHA and may add only its new adversarial test file. Prompt 08 supervises its checkpoint too.
6. Any Prompt 07 production defect returns ownership to Prompt 06 through a new, explicitly assigned remediation round. Never let both owners edit the source concurrently.

## Shared non-negotiables

1. Start by reading `AGENTS.md`, `docs/XYX_MONAD_PRD.md`, `docs/XYX_MONAD_BLUEPRINT.md`, and `docs/XYX_IMPLEMENTATION_WORKSTREAMS.md`. Read `apps/web/AGENTS.md` before web changes.
2. Work directly in `/home/pupulion/xyx-monad` with available local tools: `rg`, `git`, `forge`, `npm`, `bash`, `jq`, and `command -v`. Inspect `git status --short` and relevant diffs before editing. Preserve unrelated changes.
3. Use small `apply_patch` edits. Never use `git reset`, `git checkout`, destructive cleanup, or broad deletion.
4. Monad Testnet only. Confirm mutable facts with official Monad documentation and live read-only checks immediately before any live action. Expected chain ID is `10143`.
5. Do not install a package/tool solely to hide a failure. Do not delegate to another coding agent or claim a different agent did the work.
6. Do not deploy, broadcast, access private keys, request wallet secrets, or claim a live receipt/source verification/Testnet run unless that specific task gives explicit authorization and observed evidence.
7. Keep raw private terms, delivery/evidence, credential IDs, PRF output, seeds, private keys, sessions, RPC credentials, API keys, and signed transaction payloads out of Git, logs, public storage, browser persistence, and handoff text.
8. A local test, fixture, simulation, prepared request, or script output is not live evidence. Use `LOCAL_TESTED`, `PENDING`, `UNVERIFIED`, `CONFLICT`, and `LIVE_VERIFIED` exactly as defined in the PRD.
9. Do not introduce Envio, x402, ERC-8004, C2PA, IPFS public evidence, admin/pauser roles, marketplace/fees, upgradeability, relayers, Mainnet, React Native, or a central resolver.

## Required handoff

Every owner reports in English: scope/files/dependencies; requirement-to-code alignment; ABI/schema/public-data effect; exact positive and negative test commands/results; local versus Testnet evidence; residual security/privacy risk; recovery or migration path; and next owner. Run the relevant gates during work and all repository gates before a release-ready handoff.
