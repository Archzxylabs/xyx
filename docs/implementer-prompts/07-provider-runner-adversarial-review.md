# Prompt — Independent Provider Runner Adversarial Review Owner

```text
You are the independent adversarial test and review owner for the XYX B1 provider runner in:

/home/pupulion/xyx-monad

This assignment starts only after Prompt 06 is complete and the release owner provides its exact reviewed remediation checkpoint SHA. Do not work from a dirty handoff, branch name, tag name, report file, or verbal claim. Confirm HEAD equals the supplied SHA. If it does not, stop and report the mismatch. Do not delegate to another coding agent.

Read in full:
- AGENTS.md
- docs/XYX_MONAD_PRD.md
- docs/XYX_AGENT_WORKFLOW.md
- docs/XYX_IMPLEMENTATION_WORKSTREAMS.md, especially B1 and release gates
- docs/implementer-prompts/README.md
- docs/implementer-prompts/SOURCES.md
- docs/implementer-prompts/06-provider-runner-security-remediation.md
- the Prompt 06 handoff and exact diff at the supplied SHA
- packages/monad/src/provider-runner/{runner,adapters,index}.ts
- packages/monad/src/{canonical-chain,chain-primitives,delivery-chain,delivery,protocol,settlement}.ts
- all existing packages/monad/test/provider-runner*.test.ts files

Use official Monad block-state documentation from SOURCES.md. `latest` is speculative; only independently observed finalized receipt/state/log agreement may support a final result. Do not deploy, broadcast, use credentials, contact live RPCs, or call local fixtures Testnet evidence.

## Exclusive write ownership

You may create and edit exactly one file:

packages/monad/test/provider-runner-adversarial-review.test.ts

Do not edit production source, existing tests, docs, configuration, contracts, web files, scripts, or package manifests. If an adversarial test reveals a defect, leave the failing test and report it; do not fix production code. The release owner will return source ownership to Prompt 06 in a separate round. Preserve unrelated changes.

## Review mission

Independently challenge the repaired implementation. Do not copy Prompt 06's tests mechanically. Build fresh minimal doubles and assert externally observable behavior.

Your new test file must cover:

### Recovery evidence integrity
- Attempt recovery with invented transfer token, sender, recipient, amount, transaction hash, block number, block hash, and timestamp while the submission receipt/job are otherwise valid.
- Prove no invented field is returned as `ObservedTransfer` and no such input reaches `FINALIZED` without a matching finalized transfer receipt from both RPCs.
- Make primary and secondary disagree independently on transfer logs, receipt block hash, historical job state, and finalized head. Every case must fail closed.
- Supply a noncanonical request: wrong protocol, job ID, provider, function name, or commitment. It must not settle.

### Privacy boundary
- Use distinctive markers for private input, salt, executor success output, executor failure reason, signer rejection reason, RPC error text, credential-looking text, and tokenized URLs.
- Serialize every returned/thrown `RunnerError`, `RunStep`, `RunEvidence`, and recovery outcome with a bigint-safe serializer.
- Assert none of the markers appears. A digest/hash is allowed; raw markers are not.

### Preflight ordering
- Configure `requirement.token !== paymentToken` and inject call-count spies for private input, executor, transfer hook, signer, and readers beyond the minimum constructor checks.
- Assert rejection occurs before any private work or monetary/signing side effect. The transfer and signer call counts must remain zero.
- Repeat for malformed/zero recipient, non-positive amount, malformed observed hash, and wrong configured chain ID where applicable.

### Broadcast/reconciliation states
- A signer-returned valid hash plus missing/non-final receipt must return a structured pending/`SUBMITTED` outcome retaining the exact hash.
- It must not return `FINALIZED`, discard the hash, or broadcast twice.
- No-hash remains `SUBMITTED_AMBIGUOUS` and tells the caller not to resend blindly.
- A known hash with two-RPC conflict remains explicit conflict/non-success while retaining enough non-secret information for manual reconciliation.
- A later `settle()` call verifies without invoking the signer.

### Positive control
- Keep one honest fully local happy-path control showing that matching Monad Testnet chain IDs, two-reader finalized transfer evidence, canonical request, finalized `DeliverySubmitted` receipt, and matching historical storage can produce `FINALIZED`.
- Label it LOCAL_TESTED. It is not a Testnet receipt.

## Verification

Run:
1. `node --import tsx --test packages/monad/test/provider-runner-adversarial-review.test.ts`
2. `node --import tsx --test packages/monad/test/provider-runner.test.ts packages/monad/test/provider-runner-settle.test.ts packages/monad/test/provider-runner-privacy.test.ts packages/monad/test/provider-runner-dual-rpc.test.ts packages/monad/test/provider-runner-adversarial-review.test.ts`
3. `npm run typecheck`
4. `npm test`
5. `npm run test:contracts`
6. `npm run build:web`
7. `git diff --check`

Do not hide a failed full gate behind a targeted pass. If nested-process restrictions or another environment condition blocks a gate, record the exact failure as NOT RUN/FAIL and keep the release blocked until it is rerun successfully in an appropriate environment.

## Handoff

Do not commit unless explicitly authorized. Report:
- supplied checkpoint SHA and whether HEAD matched;
- the one test file added;
- each attack attempted and its observed result;
- exact command results/exit codes;
- any failing test with the smallest reproducible input and owning Prompt 06 requirement;
- confirmation that production source was not edited;
- explicit LOCAL_TESTED-only status and confirmation that no Testnet action occurred.

Decision must be exactly one of:
- `ACCEPT_FOR_RELEASE-OWNER_REVIEW` — every targeted and repository gate passed; or
- `RETURN_TO_PROMPT_06` — any defect, missing evidence, or gate failure remains.

Neither decision authorizes merge, deployment, broadcast, signing, or a live-status claim.

## Mandatory supervised checkpoints

Stop and return a sanitized `xyx.implementer-checkpoint.v1` report to Prompt 08 after the new adversarial test is written and again after all gates are attempted. Do not run Jev yourself. Do not edit production source in response to a correction packet. `RETURN_TO_IMPLEMENTER_06` transfers ownership back through the release owner; `RETURN_TO_REVIEWER_07` permits changes only to your one owned test file; `HUMAN_RELEASE_REVIEW` ends your work but does not authorize merge or release.
```
