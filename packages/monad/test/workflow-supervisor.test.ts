import assert from 'node:assert/strict';
import test from 'node:test';
import {
  inspectSupervisorCheckpoint,
  parseSupervisorCheckpoint,
  runJevBuildSupervisor,
  SUPERVISOR_REPORT_SCHEMA,
  SUPERVISOR_RESULT_SCHEMA,
  type SupervisorCheckpoint,
} from '../src/workflow-supervisor';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const IMPLEMENTER_PATHS = [
  'packages/monad/src/provider-runner/runner.ts',
  'packages/monad/src/provider-runner/adapters.ts',
  'packages/monad/src/provider-runner/index.ts',
  'packages/monad/test/provider-runner.test.ts',
  'packages/monad/test/provider-runner-settle.test.ts',
  'packages/monad/test/provider-runner-privacy.test.ts',
  'packages/monad/test/provider-runner-dual-rpc.test.ts',
];
const REVIEWER_PATHS = ['packages/monad/test/provider-runner-adversarial-review.test.ts'];
const ENV = { TYPESAFE_API_KEY: 'test-only-placeholder', TYPESAFE_MODEL: 'jev-latest' };

function checkpoint(overrides: Partial<SupervisorCheckpoint> = {}): SupervisorCheckpoint {
  return {
    schema: SUPERVISOR_REPORT_SCHEMA,
    stage: 'IMPLEMENTER_06',
    round: 1,
    baselineSha: SHA_A,
    headSha: SHA_B,
    task: { id: 'provider-runner-remediation', title: 'Repair provider runner evidence boundaries' },
    ownership: {
      allowedPaths: [...IMPLEMENTER_PATHS],
      filesChanged: ['packages/monad/src/provider-runner/runner.ts', 'packages/monad/test/provider-runner.test.ts'],
    },
    observed: {
      gates: { targeted: 'PASS', node: 'PASS', typecheck: 'PASS', contracts: 'PASS', web: 'PASS', diffCheck: 'PASS' },
      checks: {
        recoveryEvidence: 'PASS',
        errorPrivacy: 'PASS',
        preflightSideEffects: 'PASS',
        pendingReconciliation: 'PASS',
        testQuality: 'PASS',
      },
      changeSummary: [
        'Recovery rebuilds returned transfer facts from two reader observations.',
        'Public failure output uses stable runner-authored codes.',
      ],
      testEvidence: [
        'A fabricated recovery object is rejected by the targeted local test.',
        'A token mismatch leaves transfer and signer spy counts at zero.',
      ],
      claims: ['All four local regression classes pass on the checkpoint.'],
      unresolvedRisks: ['No public network action was observed.'],
    },
    proposedNextStep: 'Run independent adversarial review after release owner approval.',
    ...overrides,
  };
}

function choiceAnswer(choice: string, options: readonly string[], confidence = 0.9) {
  const probabilities = Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0]));
  return { type: 'choice', choice, probabilities, confidence };
}

const CLAIMS = ['SUPPORTED', 'OVERSTATED', 'INSUFFICIENT_EVIDENCE'];
const LANES = ['CORRECT_IMPLEMENTER_06', 'START_REVIEWER_07', 'CORRECT_REVIEWER_07', 'PLATFORM_LEAD_REVIEW'];

function response(options: {
  claim?: string;
  lane?: string;
  confidence?: number;
  defects?: Partial<Record<'recovery' | 'privacy' | 'preflight' | 'pending' | 'tests', number>>;
} = {}): Response {
  const defects = options.defects ?? {};
  return new Response(JSON.stringify({
    model: 'jev-runtime-model',
    answers: {
      claim_integrity: choiceAnswer(options.claim ?? 'SUPPORTED', CLAIMS, options.confidence ?? 0.9),
      suggested_lane: choiceAnswer(options.lane ?? 'START_REVIEWER_07', LANES, options.confidence ?? 0.9),
      recovery_evidence_defect: { type: 'noul', noul: defects.recovery ?? 0.05 },
      error_privacy_defect: { type: 'noul', noul: defects.privacy ?? 0.05 },
      preflight_side_effect_defect: { type: 'noul', noul: defects.preflight ?? 0.05 },
      pending_reconciliation_defect: { type: 'noul', noul: defects.pending ?? 0.05 },
      test_quality_defect: { type: 'noul', noul: defects.tests ?? 0.05 },
    },
    usage: { input_tokens: 200, output_tokens: 20 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('checkpoint schema rejects unknown fields, unsafe paths, and sensitive text', () => {
  assert.throws(() => parseSupervisorCheckpoint({ ...checkpoint(), extra: true }), /SUPERVISOR_REPORT_INVALID/);
  assert.throws(() => parseSupervisorCheckpoint({
    ...checkpoint(),
    ownership: { ...checkpoint().ownership, filesChanged: ['../../outside'] },
  }), /SUPERVISOR_REPORT_INVALID/);
  assert.throws(() => parseSupervisorCheckpoint({
    ...checkpoint(),
    ownership: { ...checkpoint().ownership, filesChanged: ['packages/monad/test/provider-runner*.test.ts'] },
  }), /SUPERVISOR_REPORT_INVALID/);
  assert.throws(() => parseSupervisorCheckpoint({
    ...checkpoint(),
    observed: { ...checkpoint().observed, claims: ['Bearer value appeared here.'] },
  }), /SUPERVISOR_REPORT_INVALID/);
});

test('ownership policy is fixed by stage and cannot be widened by the report', () => {
  const widened = checkpoint({
    ownership: {
      allowedPaths: [...IMPLEMENTER_PATHS, 'apps/web/**'],
      filesChanged: ['apps/web/app/demo/page.tsx'],
    },
  });
  const state = inspectSupervisorCheckpoint(widened);
  assert.equal(state.hardGate, 'BLOCKED');
  assert.ok(state.ownershipViolations.includes('DECLARED_OWNERSHIP_POLICY_MISMATCH'));
  assert.ok(state.ownershipViolations.includes('apps/web/app/demo/page.tsx'));
});

test('deterministic failure blocks before Jev and returns a correction packet', async () => {
  let calls = 0;
  const report = checkpoint({
    observed: {
      ...checkpoint().observed,
      gates: { ...checkpoint().observed.gates, targeted: 'FAIL' },
      checks: { ...checkpoint().observed.checks, recoveryEvidence: 'FAIL' },
    },
  });
  const result = await runJevBuildSupervisor(report, ENV, async () => { calls += 1; return response(); });
  assert.equal(calls, 0);
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, 'DETERMINISTIC_GATE_BLOCKED');
  assert.equal(result.nextAction, 'RETURN_TO_IMPLEMENTER_06');
  assert.ok(result.correctionPacket.some((line) => line.includes('failed deterministic gates')));
  assert.ok(result.correctionPacket.some((line) => line.includes('two finalized RPC')));
});

test('clean implementation checkpoint sends independent Choice and Noul questions', async () => {
  let body: Record<string, unknown> | undefined;
  const result = await runJevBuildSupervisor(checkpoint(), ENV, async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return response();
  });
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.schema, SUPERVISOR_RESULT_SCHEMA);
  assert.equal(result.nextAction, 'START_REVIEWER_07');
  const questions = body?.questions as Record<string, { type: string }>;
  assert.deepEqual(Object.keys(questions).sort(), [
    'claim_integrity',
    'error_privacy_defect',
    'pending_reconciliation_defect',
    'preflight_side_effect_defect',
    'recovery_evidence_defect',
    'suggested_lane',
    'test_quality_defect',
  ]);
  assert.equal(questions.claim_integrity.type, 'choice');
  assert.equal(questions.recovery_evidence_defect.type, 'noul');
  assert.ok(!JSON.stringify(body).includes(ENV.TYPESAFE_API_KEY));
});

test('Jev can identify several defects and route a concrete correction round', async () => {
  const result = await runJevBuildSupervisor(checkpoint(), ENV, async () => response({
    lane: 'CORRECT_IMPLEMENTER_06',
    defects: { recovery: 0.97, privacy: 0.92, pending: 0.81 },
  }));
  assert.equal(result.status, 'AVAILABLE');
  assert.equal(result.nextAction, 'RETURN_TO_IMPLEMENTER_06');
  assert.ok(result.correctionPacket.some((line) => line.includes('caller-authored evidence')));
  assert.ok(result.correctionPacket.some((line) => line.includes('stable runner-authored')));
  assert.ok(result.correctionPacket.some((line) => line.includes('known broadcast hash')));
});

test('overstated claims cannot advance even when Jev suggests the reviewer', async () => {
  const result = await runJevBuildSupervisor(checkpoint(), ENV, async () => response({
    claim: 'OVERSTATED',
    lane: 'START_REVIEWER_07',
  }));
  assert.equal(result.nextAction, 'RETURN_TO_IMPLEMENTER_06');
  assert.ok(result.correctionPacket.some((line) => line.includes('Rewrite or substantiate')));
});

test('low-confidence routing escalates to human review', async () => {
  const result = await runJevBuildSupervisor(checkpoint(), ENV, async () => response({ confidence: 0.4 }));
  assert.equal(result.nextAction, 'HUMAN_REVIEW_REQUIRED');
});

test('Jev unavailability never fabricates a correction assessment or advances', async () => {
  const result = await runJevBuildSupervisor(checkpoint(), {});
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, 'TYPESAFE_API_KEY_MISSING');
  assert.equal(result.nextAction, 'HUMAN_REVIEW_REQUIRED');
  assert.ok(!result.assessment);
});

test('reviewer ownership is one file and production defect returns to implementer 06', async () => {
  const reviewer = checkpoint({
    stage: 'REVIEWER_07',
    round: 2,
    ownership: { allowedPaths: [...REVIEWER_PATHS], filesChanged: [...REVIEWER_PATHS] },
  });
  const result = await runJevBuildSupervisor(reviewer, ENV, async () => response({
    lane: 'CORRECT_IMPLEMENTER_06',
    defects: { preflight: 0.91 },
  }));
  assert.equal(result.nextAction, 'RETURN_TO_IMPLEMENTER_06');
});

test('deterministic production failure found by reviewer returns to implementer without calling Jev', async () => {
  let calls = 0;
  const base = checkpoint();
  const reviewer = checkpoint({
    stage: 'REVIEWER_07',
    round: 2,
    ownership: { allowedPaths: [...REVIEWER_PATHS], filesChanged: [...REVIEWER_PATHS] },
    observed: {
      ...base.observed,
      checks: { ...base.observed.checks, pendingReconciliation: 'FAIL' },
    },
  });
  const result = await runJevBuildSupervisor(reviewer, ENV, async () => { calls += 1; return response(); });
  assert.equal(calls, 0);
  assert.equal(result.nextAction, 'RETURN_TO_IMPLEMENTER_06');
});

test('reviewer test-quality defect stays with reviewer rather than granting production ownership', async () => {
  const reviewer = checkpoint({
    stage: 'REVIEWER_07',
    round: 2,
    ownership: { allowedPaths: [...REVIEWER_PATHS], filesChanged: [...REVIEWER_PATHS] },
  });
  const result = await runJevBuildSupervisor(reviewer, ENV, async () => response({
    lane: 'CORRECT_REVIEWER_07',
    defects: { tests: 0.94 },
  }));
  assert.equal(result.nextAction, 'RETURN_TO_REVIEWER_07');
});

test('clean reviewer checkpoint ends at human release review, never merge authorization', async () => {
  const reviewer = checkpoint({
    stage: 'REVIEWER_07',
    round: 2,
    ownership: { allowedPaths: [...REVIEWER_PATHS], filesChanged: [...REVIEWER_PATHS] },
  });
  const result = await runJevBuildSupervisor(reviewer, ENV, async () => response({ lane: 'START_REVIEWER_07' }));
  assert.equal(result.nextAction, 'HUMAN_RELEASE_REVIEW');
});

test('malformed TypeSafe response is unavailable and requires human review', async () => {
  const result = await runJevBuildSupervisor(checkpoint(), ENV, async () => new Response(JSON.stringify({ model: 'x', answers: {} }), { status: 200 }));
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, 'JEV_RESPONSE_INVALID');
  assert.equal(result.nextAction, 'HUMAN_REVIEW_REQUIRED');
});
