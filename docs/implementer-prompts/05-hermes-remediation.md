# Prompt — Hermes Canonical XYX Audit and Remediation

Copy this prompt into Hermes unchanged.

```text
You are the sole audit and remediation owner for:

/home/pupulion/xyx-monad

Do not delegate to Claude Code, another agent, or a subagent. Work directly with local tools available on this PC: rg, git, forge, npm, bash, jq, command -v, and small apply_patch edits. Do not install a package/tool merely to make a gate pass.

Read in full before editing:
1. /home/pupulion/xyx-monad/AGENTS.md
2. /home/pupulion/xyx-monad/docs/XYX_MONAD_PRD.md
3. /home/pupulion/xyx-monad/docs/XYX_MONAD_BLUEPRINT.md
4. /home/pupulion/xyx-monad/docs/XYX_IMPLEMENTATION_WORKSTREAMS.md
5. /home/pupulion/xyx-monad/docs/implementer-prompts/README.md
6. /home/pupulion/xyx-monad/docs/implementer-prompts/SOURCES.md
7. /home/pupulion/xyx-monad/apps/web/AGENTS.md before changing web files

Inspect git status --short and git diff first. Preserve unrelated changes. Never use git reset, git checkout, destructive cleanup, deployment, broadcast, wallet key access, or a Testnet transaction. Do not claim live deployment, receipt, source verification, passkey ceremony, outside-team integration, or Testnet run.

Canonical product facts:
- Monad Testnet only, expected chain ID 10143.
- Canonical contracts are MonadP256Verifier, XYXPasskeyRegistry, XYXDeliveryProtocol.
- Buyer selects attestor; provider accepts that attestor before buyer funding; selected attestor resolves with P256 WebAuthn action proof.
- Registry has no owner/global allowlist. Protocol has no admin, pauser, fee, upgrade, central evaluator, or public private-evidence storage.
- Mera is the reference account layer. PRF/key/seed/session/raw credential ID/private terms/delivery/evidence are never public or persisted in browser storage.
- Existing AgenticCommerce/XYXEvaluator/IPFS public-payout flow is legacy reference code only. It must not be presented as canonical XYX deployment evidence.

Audit procedure:
1. Build a requirement-to-code table for PRD sections 1–15 with source files, test evidence, proof level, contradiction, and required fix.
2. Audit contracts for lifecycle, authorization, token transfer, reentrancy, commitment/verdict, RP ID, WebAuthn, P256, consumer binding, and counter behavior. Tests must prove real authorization/status paths, not only that a guard fires before another failure.
3. Audit TypeScript for strict schemas, domain-separated commitment encoding, Testnet guards, no secret serialization, and browser-only Mera/WebAuthn boundaries.
4. Audit web copy/configuration so absent real canonical evidence remains empty/unverified; scan for inaccurate legacy/public-evidence/sponsor claims.
5. Audit scripts so canonical deployments use two RPC chain checks, exact creation-bytecode suffix decoding, finalization/binding/code validation, exact source verification, and draft/final provenance distinction.
6. Fix concrete defects with small patches and targeted tests. Do not expand scope with optional protocols.
7. Run npm run test:contracts, npm test, npm run typecheck, npm run build:web, and git diff --check. If a gate cannot run, provide exact command/error and do not call it passed.

## Required evidence-first audit method

Build your first table before changing code:

| PRD section | Requirement | Canonical source/test | Current evidence | Classification | Defect or gap | Proposed smallest action |
| --- | --- | --- | --- | --- | --- | --- |

Classify each row only as `implemented + locally tested`, `implemented but untested`, `documented only`, `legacy only`, `blocked`, `unavailable live proof`, or `contradiction`. Do not use “done,” “production-ready,” “verified,” or “live” without the exact evidence described in SOURCES.md.

### Contract audit checklist

Read `MonadP256Verifier.sol`, `XYXPasskeyRegistry.sol`, `XYXDeliveryProtocol.sol`, their interface, exact installed OpenZeppelin `WebAuthn.sol` and `P256.sol`, plus all canonical tests. Confirm each statement with source line/function and test output:

1. No owner/admin/pauser/access-control module, fee path, proxy, mutable payment token, or arbitrary resolver exists.
2. Job state cannot skip provider acceptance, be funded twice, submit twice, resolve twice, cancel after funding, resolve at/after expiry, or expire early.
3. Buyer/provider/attestor are pairwise distinct and all restricted actions use stored job accounts, not an untrusted input.
4. Verdict struct/typehash/hash path binds job, commitments, decision, timestamps, chain/protocol EIP-712 domain, nonce, and full digest. Failed downstream action cannot consume nonce/digest.
5. Registry checks RP ID hash itself because OpenZeppelin helper omits it; WebAuthn helper gets exact challenge/type/UP/UV/backup path; native P256 adapter is invoked in addition; action consumer comes from registry caller; counter policy matches PRD.
6. Assertion copied from protocol consumer cannot be consumed directly. A test should prove failure due to challenge binding, not unrelated authorization.
7. SafeERC20/reentrancy behavior is tested with token failure/reentrancy where applicable. A test that merely sees guard before an authorization failure is insufficient.
8. Events and storage do not contain raw private terms/delivery/evidence, raw credential ID, PRF output, or private keys.

When fixing a defect, add or repair the negative test first. Preserve legacy tests as legacy regression coverage unless a reviewed archival task explicitly removes them. Do not deploy native adapter as a mock; local seam proves rejection propagation only, not Testnet precompile execution.

### SDK and browser audit checklist

Inspect package exports, test files, and all browser imports. Canonical SDK must be separate from old public payout/IPFS APIs. Verify strict Zod schemas reject unknown fields; canonical commitment encoding is one implementation; every commitment includes explicit domain/salt; no JSON/order ambiguity exists; and chain guard reads 10143 before mutation.

For passkey code, verify: secure-context guard; RP host match; ES256 only; resident credential and UV; PRF request; public key parsing; raw credential-ID commitment; exact registry action challenge; client-data and authenticator-data validation; strict DER r/s conversion; local cleanup with `finally`; no localStorage/sessionStorage/log/URL/telemetry secret leak. A generic Mera call with a random challenge cannot be accepted as verdict binding.

For web code, search for legacy contract names, IPFS/manifest claims, `LIVE`, `VERIFIED`, `PROTECTED`, `console.`, storage APIs, credential/PRF/key terms, and hard-coded addresses. Missing canonical configuration must render unverified/disabled—not a fake populated flow. Confirm browser-only imports do not execute in server/static build.

### Script audit checklist

Read all scripts, not just names. Canonical script route must be distinct from legacy route and must use two RPC chain guards, exact deployment sequence, exact creation-bytecode-prefix constructor extraction, dual-RPC receipt/code/binding observations, explicit per-contract source verification, and draft/final provenance status. Scripts must normalize hex/decimal quantities, operate from any current directory, avoid env/key dumps, and be covered by offline mocked-tool tests.

### Gate and report requirements

Run every required gate only after code changes settle:

- `npm run test:contracts`
- `npm test`
- `npm run typecheck`
- `npm run build:web`
- `git diff --check`

For each command include command, exit code, totals, and relevant failures. If unavailable, say `not run` and why. Do not paste invented prior output. State separately: local test evidence, local static evidence, Testnet evidence (normally unavailable in this task), and external-integration evidence (normally unavailable).

Your final English report must contain: alignment table; exact files/behavior changed; exact gate output; local-only versus live-unavailable evidence; remaining blockers; and the smallest next action. Do not write a completion report until all asserted work has fresh command evidence.
```
