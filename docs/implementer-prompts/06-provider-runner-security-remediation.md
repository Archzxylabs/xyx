# Prompt — Provider Runner Security Remediation Owner

```text
You are the sole implementation owner for the XYX B1 provider-runner security remediation in:

/home/pupulion/xyx-monad

This is a sequential assignment. Do not begin until the release owner supplies one exact reviewed baseline commit SHA that contains the current provider-runner source and tests. The current working tree may contain unrelated or untracked work; a filename, report, tag, or dirty working tree is not a baseline. Confirm HEAD and the supplied SHA before editing. If they differ, stop and report the mismatch. Do not delegate to another coding agent.

Read in full before editing:
- AGENTS.md
- docs/XYX_MONAD_PRD.md
- docs/XYX_AGENT_WORKFLOW.md
- docs/XYX_MONAD_BLUEPRINT.md
- docs/XYX_IMPLEMENTATION_WORKSTREAMS.md, especially B1 and the release gates
- docs/implementer-prompts/README.md
- docs/implementer-prompts/SOURCES.md
- packages/monad/src/provider-runner/{runner,adapters,index}.ts
- packages/monad/src/{canonical-chain,chain-primitives,delivery-chain,delivery,protocol,settlement}.ts
- all packages/monad/test/provider-runner*.test.ts files

Use current official Monad documentation from SOURCES.md for block-state semantics. Monad Testnet chain ID is 10143. Treat `latest` as speculative and `finalized` as the irreversible confirmation boundary. Do not deploy, broadcast, use a wallet/key, contact a live RPC, or describe any fixture/local result as a Testnet action.

## Exclusive write ownership

You may edit only:
- packages/monad/src/provider-runner/runner.ts
- packages/monad/src/provider-runner/adapters.ts
- packages/monad/src/provider-runner/index.ts, only if the public type/API must change
- packages/monad/test/provider-runner.test.ts
- packages/monad/test/provider-runner-settle.test.ts
- packages/monad/test/provider-runner-privacy.test.ts
- packages/monad/test/provider-runner-dual-rpc.test.ts

Do not edit contracts, web files, scripts, canonical-chain.ts, chain-primitives.ts, package manifests, PRD/workstream documents, or unrelated tests. If a correct fix genuinely requires one of those paths, stop and issue a short interface-change request; do not cross the ownership boundary. Preserve every unrelated working-tree change.

## Confirmed defects to repair

### 1. Recovery must not trust caller-authored evidence

`settle()` currently accepts a structurally fabricated `PreparedDelivery`, verifies only the `submitDelivery` transaction, and then republishes `prepared.transfer` as evidence. A caller can supply invented transfer hash, block, token, sender, recipient, and amount while receiving `FINALIZED`.

Required behavior:
- No caller-supplied object may become `ObservedTransfer` merely because its fields have the right TypeScript shape.
- A recovery artifact may carry a transaction hash as a locator, but every public transfer fact must be reconstructed from finalized chain data independently read from both configured RPC readers.
- Re-run the same token, provider sender, recipient, exact amount, receipt-success, block-hash, and finality checks used by normal preparation.
- Ensure the transfer hash bound inside the prepared private delivery agrees with the independently observed transfer.
- Validate that the prepared submission request is the canonical request for the configured protocol, job ID, provider, and commitment; do not trust arbitrary `address`, `functionName`, `args`, or `from` fields.
- If recovery lacks sufficient information to re-observe the transfer, return/throw a non-success state. Never emit `FINALIZED` with incomplete evidence.
- Build returned evidence from observations, not by copying untrusted prepared fields.

You may redesign `PreparedDelivery`/the recovery input if needed. Prefer a minimal recovery handle over a public evidence-shaped object. Document compatibility impact in the handoff; do not silently retain an unsafe API for compatibility.

### 2. Public errors and evidence must not leak collaborator-controlled text

The executor's `{ ok: false, reason }` and the signer's rejected `reason` currently flow into `RunnerError`, `RunStep`, or `RunEvidence.failure`. Those strings can contain private delivery text, bearer credentials, RPC URLs, wallet errors, or other secrets.

Required behavior:
- Public runner errors, steps, and evidence use stable bounded messages/codes authored by the runner.
- Never interpolate or copy raw executor reason, signer reason, thrown provider-input text, RPC URL, authorization header, private material, salt, or executor result into public output.
- If an integrator needs private diagnostics, keep that concern outside the public evidence object; do not add a secret-bearing debug field.
- Correct comments and public types so their privacy claims match enforceable runtime behavior.

### 3. Reject token/spec mismatch before any side effect

The configured transfer requirement can name a token different from `paymentToken`. The mismatch is currently detected only after `transfer.execute()` may already have moved assets.

Required behavior:
- Compare addresses case-insensitively during constructor/preflight validation.
- Reject mismatched `requirement.token` and `paymentToken` before calling `privateInput.provide`, `executor.execute`, `transfer.execute`, or any signer.
- Preserve the zero-side-effect guarantee for every invalid address/amount/hash/chain/spec case that can be known before execution.

### 4. Preserve a known broadcast hash while finality is pending

When the signer returns a valid transaction hash and the receipt is absent or not finalized, `run()` currently throws without returning a structured recovery outcome.

Required behavior:
- A known broadcast hash is evidence of submission only, never execution/finality.
- Return a structured `SUBMITTED`/pending outcome that retains the hash and tells the caller to reconcile; do not report `FINALIZED`, silently retry, or discard the hash.
- Keep `SUBMITTED_AMBIGUOUS` exclusively for the no-hash case.
- RPC disagreement remains `CONFLICT`/an explicit RPC-conflict failure and must never become success.
- `settle()` remains the non-broadcast reconciliation path and must not resend.

## Mandatory regression tests

Add or update tests that prove all of the following:
1. A completely fabricated transfer inside a recovery object cannot produce `FINALIZED`.
2. Changing only transfer token, sender, recipient, amount, transaction hash, block number, or block hash is independently rejected unless both RPCs really prove the new fact.
3. A fabricated/noncanonical request cannot be used for recovery.
4. Executor failure text containing a plaintext marker, bearer token marker, URL marker, and salt marker is absent from serialized `RunnerError`, `RunStep`, and `RunEvidence`.
5. Signer rejection text with the same markers is absent from public output.
6. A payment-token mismatch rejects before all injected provider/executor/transfer/signer spies; every call count remains zero.
7. A signer-returned hash with an unavailable or non-final receipt produces structured `SUBMITTED` evidence containing that hash and never `FINALIZED`.
8. No-hash remains `SUBMITTED_AMBIGUOUS`; two-RPC receipt/state disagreement remains fail-closed.
9. Happy-path preparation, broadcast verification, and recovery still require Monad Testnet chain ID 10143 and two-reader finalized agreement.

Tests may use synthetic local fixtures, but their names/comments must state that they are local only. Do not add a mock mode or any output that can be confused with a live receipt.

## Required verification

Run, in this order, against the final on-disk state:
1. `node --import tsx --test packages/monad/test/provider-runner.test.ts packages/monad/test/provider-runner-settle.test.ts packages/monad/test/provider-runner-privacy.test.ts packages/monad/test/provider-runner-dual-rpc.test.ts`
2. `npm run typecheck`
3. `npm test`
4. `npm run test:contracts`
5. `npm run build:web`
6. `git diff --check`

If the environment blocks a command, report the exact command and blocker as NOT RUN/FAIL; do not substitute an older log. A passing targeted test does not override a failing repository gate.

## Handoff

Do not commit unless the release owner explicitly authorizes it. Report:
- baseline SHA and final `git status --short` for owned paths;
- exact files changed;
- public API/type compatibility changes;
- a defect-to-test mapping for all four confirmed defects;
- exact fresh command results and exit codes;
- explicit statement that evidence is LOCAL_TESTED only and no Testnet action occurred;
- residual risks and the exact paths reserved for Prompt 07.

End by asking the release owner to review the diff and provide one remediation checkpoint SHA to the independent Prompt 07 owner. Do not start Prompt 07 yourself.

## Mandatory supervised checkpoints

Stop and return a sanitized `xyx.implementer-checkpoint.v1` report to the Prompt 08 supervisor at these points:

1. After reproducing the defects and before the first production edit.
2. After targeted tests pass.
3. After all repository gates have been attempted.
4. After every correction round requested by the supervisor.

Do not call Jev yourself and do not continue from one checkpoint merely because your own report says PASS. The Prompt 08 owner independently inspects source/path/gate facts, runs the real-only supervisor command, and returns an effective action plus correction packet. Apply every correction that stays inside this prompt's ownership. If the effective action is `HUMAN_REVIEW_REQUIRED`, stop. Only `START_REVIEWER_07` allows the release owner to prepare the reviewer handoff; it still does not authorize commit or merge.
```
