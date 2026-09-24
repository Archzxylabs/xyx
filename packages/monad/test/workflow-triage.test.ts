import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  determineWorkflowHardGate,
  parseWorkflowReport,
  runJevWorkflowTriage,
  WORKFLOW_REPORT_SCHEMA,
  WORKFLOW_TRIAGE_SCHEMA,
  type WorkflowReport,
} from '../src/workflow-triage';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const CLI_ENV = { ...process.env };
delete CLI_ENV.NODE_TEST_CONTEXT;
const CLAIM_INTEGRITY_OPTIONS = ['SUPPORTED', 'OVERSTATED', 'INSUFFICIENT_EVIDENCE'] as const;
const REVIEW_LANE_OPTIONS = [
  'CONTRACT_SECURITY',
  'SDK_ABI',
  'WEB_TRUTHFULNESS',
  'CHAIN_OPERATIONS',
  'DOCS_PRODUCT',
  'PLATFORM_LEAD',
] as const;

function fullyObservedReport(overrides: Partial<WorkflowReport> = {}): WorkflowReport {
  return {
    ...report(),
    observed: {
      ...report().observed,
      testnet: {
        deploymentObserved: true,
        broadcastObserved: true,
        receiptObserved: true,
        sourceVerificationObserved: true,
      },
    },
    ...overrides,
  };
}

function choiceResponse(overrides: {
  answers?: Record<string, unknown>;
  body?: Record<string, unknown>;
  status?: number;
} = {}): Response {
  const body = {
    model: 'jev-1.13.0',
    answers: {
      claim_integrity: {
        type: 'choice',
        choice: 'SUPPORTED',
        probabilities: { SUPPORTED: 0.88, OVERSTATED: 0.12, INSUFFICIENT_EVIDENCE: 0 },
        confidence: 0.81,
      },
      review_lane: {
        type: 'choice',
        choice: 'SDK_ABI',
        probabilities: {
          CONTRACT_SECURITY: 0.05,
          SDK_ABI: 0.7,
          WEB_TRUTHFULNESS: 0.1,
          CHAIN_OPERATIONS: 0.05,
          DOCS_PRODUCT: 0.05,
          PLATFORM_LEAD: 0.05,
        },
        confidence: 0.6,
      },
      ...(overrides.answers ?? {}),
    },
    usage: { input_tokens: 296, output_tokens: 20 },
    ...(overrides.body ?? {}),
  };
  return new Response(JSON.stringify(body), {
    status: overrides.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Capture the outbound request instead of performing it. No real network call. */
function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): {
  calls: { url: string; init: RequestInit }[];
  restore: () => void;
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const ENV_WITH_KEY = { TYPESAFE_API_KEY: 'test-key-not-a-real-credential' };

function report(overrides: Partial<WorkflowReport> = {}): WorkflowReport {
  return {
    schema: 'xyx.agent-work-report.v1',
    task: {
      id: 'workflow-triage',
      title: 'Review SDK evidence binding',
      areas: ['SDK_ABI'],
    },
    observed: {
      filesChanged: ['packages/monad/src/protocol.ts'],
      gates: { contracts: 'PASS', node: 'PASS', typecheck: 'PASS', web: 'PASS' },
      testnet: {
        deploymentObserved: false,
        broadcastObserved: false,
        receiptObserved: false,
        sourceVerificationObserved: false,
      },
      unresolvedRisks: ['No public Testnet receipt is observed.'],
    },
    claims: ['All local gates pass; this is local evidence only.'],
    proposedNextStep: 'Codex reviews the ABI and asks for human deployment authorization separately.',
    ...overrides,
  };
}

test('workflow hard gate blocks a failed deterministic gate before Jev can influence it', () => {
  const value = report({
    observed: {
      ...report().observed,
      gates: { contracts: 'FAIL', node: 'PASS', typecheck: 'PASS', web: 'PASS' },
    },
  });
  assert.equal(determineWorkflowHardGate(value), 'BLOCKED');
});

test('workflow hard gate labels green local work as local-only without live evidence', () => {
  assert.equal(determineWorkflowHardGate(report()), 'LOCAL_EVIDENCE_ONLY');
});

test('workflow report rejects values that could expose a secret or endpoint', () => {
  assert.throws(
    () => parseWorkflowReport({ ...report(), claims: ['Authorization: Bearer should never appear here.'] }),
    /WORKFLOW_REPORT_INVALID/,
  );
  assert.throws(
    () => parseWorkflowReport({ ...report(), proposedNextStep: 'Read https://example.invalid/key before review.' }),
    /WORKFLOW_REPORT_INVALID/,
  );
  assert.throws(
    () => parseWorkflowReport({ ...report(), unresolvedRisks: ['a'.repeat(64)] }),
    /WORKFLOW_REPORT_INVALID/,
  );
});

test('missing credential is unavailable and never fabricates a Jev assessment', async () => {
  const result = await runJevWorkflowTriage(report(), {});
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, 'TYPESAFE_API_KEY_MISSING');
  assert.equal(result.hardGate, 'LOCAL_EVIDENCE_ONLY');
  assert.ok(!('assessment' in result));
  assert.ok(!('model' in result));
});

test('every deterministic hard gate state is reachable and FAIL wins over NOT_RUN', () => {
  const notRun = report({
    observed: { ...report().observed, gates: { contracts: 'PASS', node: 'NOT_RUN', typecheck: 'PASS', web: 'PASS' } },
  });
  assert.equal(determineWorkflowHardGate(notRun), 'INCOMPLETE_LOCAL_EVIDENCE');
  assert.equal(determineWorkflowHardGate(fullyObservedReport()), 'HUMAN_REVIEW_REQUIRED');

  const failedAndNotRun = report({
    observed: { ...report().observed, gates: { contracts: 'FAIL', node: 'NOT_RUN', typecheck: 'PASS', web: 'PASS' } },
  });
  assert.equal(determineWorkflowHardGate(failedAndNotRun), 'BLOCKED');
});

test('a single missing live observation keeps the gate below human review', () => {
  const observed = fullyObservedReport().observed.testnet;
  for (const key of Object.keys(observed) as (keyof typeof observed)[]) {
    const value = report({ observed: { ...fullyObservedReport().observed, testnet: { ...observed, [key]: false } } });
    assert.equal(determineWorkflowHardGate(value), 'LOCAL_EVIDENCE_ONLY', key);
  }
});

test('an unusable model name is unavailable instead of sending a malformed request', async () => {
  for (const model of ['', '   ', 'jev latest', 'x'.repeat(129), 'Bearer sk-live']) {
    const stub = stubFetch(() => choiceResponse());
    const result = await runJevWorkflowTriage(report(), { ...ENV_WITH_KEY, TYPESAFE_MODEL: model });
    stub.restore();
    assert.equal(result.status, 'UNAVAILABLE', model);
    assert.equal(result.reason, 'TYPESAFE_MODEL_INVALID', model);
    assert.equal(stub.calls.length, 0, 'no request may be sent');
  }
});

test('an invalid model name in the environment never reaches the report digest', async () => {
  const stub = stubFetch(() => choiceResponse());
  const result = await runJevWorkflowTriage(report(), { ...ENV_WITH_KEY, TYPESAFE_MODEL: 'Bearer sk-live' });
  stub.restore();
  assert.equal(result.status, 'UNAVAILABLE');
  assert.ok(!('model' in result));
});

test('the outbound request matches the TypeSafe System One contract and never carries the key', async () => {
  const stub = stubFetch(() => choiceResponse());
  const result = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
  stub.restore();

  assert.equal(result.status, 'AVAILABLE');
  assert.equal(stub.calls.length, 1);

  const { url, init } = stub.calls[0];
  assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(init.method, 'POST');

  const headers = init.headers as Record<string, string>;
  assert.equal(headers.authorization, 'Bearer test-key-not-a-real-credential');
  assert.equal(headers['content-type'], 'application/json');

  const body = JSON.parse(String(init.body));
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(body.model, 'jev-latest');
  assert.equal(body.state.report.schema, WORKFLOW_REPORT_SCHEMA);
  assert.equal(body.state.deterministicPolicy.hardGate, 'LOCAL_EVIDENCE_ONLY');
  assert.ok(!JSON.stringify(body).includes('test-key-not-a-real-credential'), 'key must stay in the header only');
  assert.ok(!JSON.stringify(body).match(/0x[0-9a-f]{64}/i), 'report digest must not leave the repository');

  assert.deepEqual(Object.keys(body.questions).sort(), ['claim_integrity', 'review_lane']);
  assert.deepEqual(
    Object.keys(body.questions.claim_integrity.criteria).sort(),
    [...CLAIM_INTEGRITY_OPTIONS].sort(),
  );
  assert.deepEqual(
    Object.keys(body.questions.review_lane.criteria).sort(),
    [...REVIEW_LANE_OPTIONS].sort(),
  );
  for (const question of Object.values(body.questions) as Record<string, unknown>[]) {
    assert.equal(question.type, 'choice');
    assert.equal(typeof question.instructions, 'string');
    assert.ok((question.instructions as string).length > 0);
  }
});

test('a real choice response is validated and returned as AVAILABLE without recomputation', async () => {
  const stub = stubFetch(() => choiceResponse());
  const result = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
  stub.restore();

  assert.equal(result.status, 'AVAILABLE');
  if (result.status !== 'AVAILABLE') return;
  assert.ok(!('model' in result));
  assert.equal(result.schema, WORKFLOW_TRIAGE_SCHEMA);
  assert.equal(result.hardGate, 'LOCAL_EVIDENCE_ONLY');
  assert.match(result.reportDigest, /^0x[0-9a-f]{64}$/);
  assert.equal(result.assessment.provider, 'typesafe');
  assert.equal(result.assessment.model, 'jev-1.13.0');
  assert.equal(result.assessment.claimIntegrity.choice, 'SUPPORTED');
  assert.equal(result.assessment.claimIntegrity.confidence, 0.81);
  assert.deepEqual(Object.keys(result.assessment.claimIntegrity.probabilities).sort(), [...CLAIM_INTEGRITY_OPTIONS].sort());
  assert.equal(result.assessment.reviewLane.choice, 'SDK_ABI');
  assert.deepEqual(Object.keys(result.assessment.reviewLane.probabilities).sort(), [...REVIEW_LANE_OPTIONS].sort());
});

test('a malformed or manipulated Jev response is rejected rather than repaired', async () => {
  const cases: { name: string; overrides: Parameters<typeof choiceResponse>[0]; reason: string }[] = [
    {
      name: 'probabilities that do not sum to one',
      overrides: {
        answers: {
          claim_integrity: {
            type: 'choice',
            choice: 'SUPPORTED',
            probabilities: { SUPPORTED: 0.5, OVERSTATED: 0.2, INSUFFICIENT_EVIDENCE: 0.1 },
            confidence: 0.5,
          },
        },
      },
      reason: 'JEV_RESPONSE_INVALID',
    },
    {
      name: 'one defined option missing from probabilities',
      overrides: {
        answers: {
          claim_integrity: {
            type: 'choice',
            choice: 'SUPPORTED',
            probabilities: { SUPPORTED: 0.9, OVERSTATED: 0.1 },
            confidence: 0.9,
          },
        },
      },
      reason: 'JEV_RESPONSE_INVALID',
    },
    {
      name: 'a choice outside the defined options',
      overrides: {
        answers: {
          claim_integrity: {
            type: 'choice',
            choice: 'MAYBE',
            probabilities: { SUPPORTED: 0.5, OVERSTATED: 0.5, INSUFFICIENT_EVIDENCE: 0 },
            confidence: 0.5,
          },
        },
      },
      reason: 'JEV_RESPONSE_INVALID',
    },
    {
      name: 'an extra answer id',
      overrides: { answers: { third_question: { type: 'choice', choice: 'SUPPORTED', probabilities: {}, confidence: 1 } } },
      reason: 'JEV_RESPONSE_INVALID',
    },
    {
      name: 'usage with an unexpected field',
      overrides: { body: { usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 1 } } },
      reason: 'JEV_RESPONSE_INVALID',
    },
    {
      name: 'a model field that could leak a credential',
      overrides: { body: { model: 'Bearer sk-live-secret' } },
      reason: 'JEV_RESPONSE_INVALID',
    },
  ];

  for (const { name, overrides, reason } of cases) {
    const stub = stubFetch(() => choiceResponse(overrides));
    const result = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
    stub.restore();
    assert.equal(result.status, 'UNAVAILABLE', name);
    assert.equal(result.reason, reason, name);
    assert.ok(!('assessment' in result), name);
  }
});

test('a non-JSON body is unavailable rather than partially parsed', async () => {
  const stub = stubFetch(() => new Response('not json at all', { status: 200 }));
  const result = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
  stub.restore();
  assert.equal(result.status, 'UNAVAILABLE');
  assert.equal(result.reason, 'JEV_RESPONSE_INVALID');
});

test('HTTP failure codes map to their distinct reasons without retry abuse', async () => {
  const cases: { status: number; reason: string; expectedCalls: number }[] = [
    { status: 401, reason: 'JEV_AUTH_FAILED', expectedCalls: 1 },
    { status: 422, reason: 'JEV_REQUEST_INVALID', expectedCalls: 1 },
    { status: 429, reason: 'JEV_RATE_LIMITED', expectedCalls: 3 },
    { status: 529, reason: 'JEV_SERVICE_UNAVAILABLE', expectedCalls: 3 },
    { status: 500, reason: 'JEV_HTTP_ERROR', expectedCalls: 1 },
  ];

  for (const { status, reason, expectedCalls } of cases) {
    const stub = stubFetch(() => choiceResponse({ status }));
    const result = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
    stub.restore();
    assert.equal(result.status, 'UNAVAILABLE', String(status));
    assert.equal(result.reason, reason, String(status));
    assert.equal(stub.calls.length, expectedCalls, String(status));
  }
});

test('a rate-limited request is retried and a later success becomes AVAILABLE', async () => {
  const stub = stubFetch((_url, init) =>
    (stub.calls as unknown as { length: number }).length === 1 ? choiceResponse({ status: 429 }) : choiceResponse(),
  );
  const result = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
  stub.restore();
  assert.equal(stub.calls.length, 2);
  assert.equal(result.status, 'AVAILABLE');
});

test('transport failures and timeouts are unavailable and never throw', async () => {
  const timeoutStub = stubFetch(() => {
    const error = new Error('aborted');
    error.name = 'TimeoutError';
    throw error;
  });
  const timedOut = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
  timeoutStub.restore();
  assert.equal(timedOut.status, 'UNAVAILABLE');
  assert.equal(timedOut.reason, 'JEV_TIMEOUT');

  const networkStub = stubFetch(() => {
    throw new Error('socket closed');
  });
  const failed = await runJevWorkflowTriage(report(), ENV_WITH_KEY);
  networkStub.restore();
  assert.equal(failed.status, 'UNAVAILABLE');
  assert.equal(failed.reason, 'JEV_REQUEST_FAILED');
});

test('the report digest is stable for equivalent input and changes with content', async () => {
  const first = await runJevWorkflowTriage(report(), {});
  const second = await runJevWorkflowTriage({ ...report(), claims: ['All local gates pass; this is local evidence only.'] }, {});
  assert.equal(first.status, 'UNAVAILABLE');
  assert.equal(second.status, 'UNAVAILABLE');
  assert.equal(first.reportDigest, second.reportDigest);

  const changed = await runJevWorkflowTriage(report({ claims: ['A different claim.'] }), {});
  assert.notEqual(first.reportDigest, changed.reportDigest);
});

test('a report with an unknown field or an unsafe file path is rejected', () => {
  assert.throws(() => parseWorkflowReport({ ...report(), extra: 'nope' }), /WORKFLOW_REPORT_INVALID/);
  assert.throws(
    () => parseWorkflowReport({ ...report(), observed: { ...report().observed, filesChanged: ['../../etc/passwd'] } }),
    /WORKFLOW_REPORT_INVALID/,
  );
  assert.throws(
    () => parseWorkflowReport({ ...report(), observed: { ...report().observed, filesChanged: ['/etc/passwd'] } }),
    /WORKFLOW_REPORT_INVALID/,
  );
  assert.throws(() => parseWorkflowReport({ ...report(), claims: [] }), /WORKFLOW_REPORT_INVALID/);
  assert.throws(() => parseWorkflowReport({ ...report(), task: { ...report().task, areas: [] } }), /WORKFLOW_REPORT_INVALID/);
});

test('the CLI exits 0 for --help and 2 for usage and unreadable input', () => {
  const help = spawnSync('node', ['--import', 'tsx', join(REPO_ROOT, 'scripts/jev-workflow-triage.ts'), '--help'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: CLI_ENV,
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: npm run workflow:triage/);

  const usage = spawnSync('node', ['--import', 'tsx', join(REPO_ROOT, 'scripts/jev-workflow-triage.ts')], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: CLI_ENV,
  });
  assert.equal(usage.status, 2);

  const directory = mkdtempSync(join(tmpdir(), 'xyx-jev-cli-'));
  const broken = join(directory, 'broken.json');
  writeFileSync(broken, '{ not json', 'utf8');
  const unreadable = spawnSync('node', ['--import', 'tsx', join(REPO_ROOT, 'scripts/jev-workflow-triage.ts'), '--input', broken], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: CLI_ENV,
  });
  assert.equal(unreadable.status, 2);
  assert.match(unreadable.stderr, /WORKFLOW_TRIAGE_INPUT_INVALID/);
});

test('the CLI exits 1 and prints UNAVAILABLE when no credential is present', () => {
  const directory = mkdtempSync(join(tmpdir(), 'xyx-jev-cli-'));
  const input = join(directory, 'report.json');
  writeFileSync(input, JSON.stringify(report()), 'utf8');

  const environment = { ...CLI_ENV };
  delete environment.TYPESAFE_API_KEY;

  const result = spawnSync('node', ['--import', 'tsx', join(REPO_ROOT, 'scripts/jev-workflow-triage.ts'), '--input', input], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: environment,
  });
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.status, 'UNAVAILABLE');
  assert.equal(parsed.reason, 'TYPESAFE_API_KEY_MISSING');
  assert.equal(parsed.hardGate, 'LOCAL_EVIDENCE_ONLY');
});
