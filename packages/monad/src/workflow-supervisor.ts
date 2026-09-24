/**
 * Jev-directed, code-controlled supervision for the XYX implementer loop.
 *
 * Deterministic ownership and gate facts always win. Jev receives only a
 * sanitized checkpoint report and returns typed judgments that select a
 * correction lane. The result can direct another implementation round, but it
 * can never edit files, merge, deploy, broadcast, sign, or authorize release.
 */

import { z } from 'zod';
import { hashJSON } from './canonical';
import { TYPESAFE_SYSTEM_ONE_URL, type ChoiceJudgment } from './workflow-triage';

export const SUPERVISOR_REPORT_SCHEMA = 'xyx.implementer-checkpoint.v1' as const;
export const SUPERVISOR_RESULT_SCHEMA = 'xyx.jev-build-supervision.v1' as const;

const STAGES = ['IMPLEMENTER_06', 'REVIEWER_07'] as const;
const CLAIM_OPTIONS = ['SUPPORTED', 'OVERSTATED', 'INSUFFICIENT_EVIDENCE'] as const;
const JEV_LANES = [
  'CORRECT_IMPLEMENTER_06',
  'START_REVIEWER_07',
  'CORRECT_REVIEWER_07',
  'PLATFORM_LEAD_REVIEW',
] as const;
const CHECKS = [
  'recoveryEvidence',
  'errorPrivacy',
  'preflightSideEffects',
  'pendingReconciliation',
  'testQuality',
] as const;

export type SupervisorStage = (typeof STAGES)[number];
export type SupervisorClaimIntegrity = (typeof CLAIM_OPTIONS)[number];
export type SupervisorJevLane = (typeof JEV_LANES)[number];
export type SupervisorCheck = (typeof CHECKS)[number];
export type SupervisorNextAction =
  | 'RETURN_TO_IMPLEMENTER_06'
  | 'RETURN_TO_REVIEWER_07'
  | 'START_REVIEWER_07'
  | 'HUMAN_REVIEW_REQUIRED'
  | 'HUMAN_RELEASE_REVIEW';

const SENSITIVE_TEXT = [
  /\bapi[ _-]?key\b/i,
  /\bprivate[ _-]?key\b/i,
  /\bseed(?:[ _-]?phrase)?\b/i,
  /\bmnemonic\b/i,
  /\bpassphrase\b/i,
  /\bpassword\b/i,
  /\bbearer\b/i,
  /\bauthorization\s*:/i,
  /\bcookie\b/i,
  /\bprf(?:[ _-]?(?:salt|output))?\b/i,
  /\bcredential(?:[ _-]?id)?\b/i,
  /\bsecret\b/i,
  /https?:\/\//i,
  /0x[0-9a-f]{64}/i,
  /\b[0-9a-f]{64}\b/i,
];

function isSafeText(value: string): boolean {
  return !SENSITIVE_TEXT.some((pattern) => pattern.test(value));
}

const boundedText = (max: number) => z.string().trim().min(1).max(max).refine(isSafeText);
const changedRepoPath = z.string().trim().min(1).max(180).regex(
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@-]+$/,
  'must be a concrete repository-relative path',
);
const ownershipRule = z.string().trim().min(1).max(180).regex(
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@*-]+$/,
  'must be a repository-relative ownership rule',
);
const sha = z.string().regex(/^[0-9a-f]{40}$/i, 'must be a full Git SHA');
const resultState = z.enum(['PASS', 'FAIL', 'NOT_RUN']);

export const supervisorCheckpointSchema = z.object({
  schema: z.literal(SUPERVISOR_REPORT_SCHEMA),
  stage: z.enum(STAGES),
  round: z.number().int().min(1).max(20),
  baselineSha: sha,
  headSha: sha,
  task: z.object({
    id: boundedText(80),
    title: boundedText(240),
  }).strict(),
  ownership: z.object({
    allowedPaths: z.array(ownershipRule).min(1).max(20),
    filesChanged: z.array(changedRepoPath).max(80),
  }).strict(),
  observed: z.object({
    gates: z.object({
      targeted: resultState,
      node: resultState,
      typecheck: resultState,
      contracts: resultState,
      web: resultState,
      diffCheck: resultState,
    }).strict(),
    checks: z.object({
      recoveryEvidence: resultState,
      errorPrivacy: resultState,
      preflightSideEffects: resultState,
      pendingReconciliation: resultState,
      testQuality: resultState,
    }).strict(),
    changeSummary: z.array(boundedText(360)).min(1).max(20),
    testEvidence: z.array(boundedText(360)).min(1).max(30),
    claims: z.array(boundedText(360)).min(1).max(20),
    unresolvedRisks: z.array(boundedText(360)).max(20),
  }).strict(),
  proposedNextStep: boundedText(360),
}).strict();

export type SupervisorCheckpoint = z.infer<typeof supervisorCheckpointSchema>;

export interface SupervisorDeterministicState {
  readonly ownershipViolations: readonly string[];
  readonly failedGates: readonly string[];
  readonly missingGates: readonly string[];
  readonly failedChecks: readonly SupervisorCheck[];
  readonly missingChecks: readonly SupervisorCheck[];
  readonly hardGate: 'BLOCKED' | 'INCOMPLETE' | 'READY_FOR_JEV';
}

export interface SupervisorJevAssessment {
  readonly provider: 'typesafe';
  readonly model: string;
  readonly claimIntegrity: ChoiceJudgment<SupervisorClaimIntegrity>;
  readonly suggestedLane: ChoiceJudgment<SupervisorJevLane>;
  readonly defectProbability: Readonly<Record<SupervisorCheck, number>>;
}

type SupervisorUnavailableReason =
  | 'DETERMINISTIC_GATE_BLOCKED'
  | 'DETERMINISTIC_EVIDENCE_INCOMPLETE'
  | 'TYPESAFE_API_KEY_MISSING'
  | 'TYPESAFE_MODEL_INVALID'
  | 'JEV_AUTH_FAILED'
  | 'JEV_REQUEST_INVALID'
  | 'JEV_RATE_LIMITED'
  | 'JEV_SERVICE_UNAVAILABLE'
  | 'JEV_HTTP_ERROR'
  | 'JEV_TIMEOUT'
  | 'JEV_REQUEST_FAILED'
  | 'JEV_RESPONSE_INVALID';

export type SupervisorResult = {
  readonly schema: typeof SUPERVISOR_RESULT_SCHEMA;
  readonly status: 'AVAILABLE' | 'UNAVAILABLE';
  readonly checkpointDigest: `0x${string}`;
  readonly deterministic: SupervisorDeterministicState;
  readonly nextAction: SupervisorNextAction;
  readonly correctionPacket: readonly string[];
  readonly assessment?: SupervisorJevAssessment;
  readonly reason?: SupervisorUnavailableReason;
};

const IMPLEMENTER_06_PATHS = [
  'packages/monad/src/provider-runner/runner.ts',
  'packages/monad/src/provider-runner/adapters.ts',
  'packages/monad/src/provider-runner/index.ts',
  'packages/monad/test/provider-runner.test.ts',
  'packages/monad/test/provider-runner-settle.test.ts',
  'packages/monad/test/provider-runner-privacy.test.ts',
  'packages/monad/test/provider-runner-dual-rpc.test.ts',
] as const;
const REVIEWER_07_PATHS = ['packages/monad/test/provider-runner-adversarial-review.test.ts'] as const;

function pathMatches(path: string, rule: string): boolean {
  if (!rule.includes('*')) return path === rule;
  const escaped = rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function canonicalAllowedPaths(stage: SupervisorStage): readonly string[] {
  return stage === 'IMPLEMENTER_06' ? IMPLEMENTER_06_PATHS : REVIEWER_07_PATHS;
}

export function parseSupervisorCheckpoint(input: unknown): SupervisorCheckpoint {
  const parsed = supervisorCheckpointSchema.safeParse(input);
  if (!parsed.success) throw new Error('SUPERVISOR_REPORT_INVALID');
  return parsed.data;
}

export function inspectSupervisorCheckpoint(report: SupervisorCheckpoint): SupervisorDeterministicState {
  const canonical = canonicalAllowedPaths(report.stage);
  const declaredRulesAreExact =
    report.ownership.allowedPaths.length === canonical.length &&
    canonical.every((rule) => report.ownership.allowedPaths.includes(rule));
  const ownershipViolations = report.ownership.filesChanged.filter(
    (path) => !canonical.some((rule) => pathMatches(path, rule)),
  );
  if (!declaredRulesAreExact) ownershipViolations.unshift('DECLARED_OWNERSHIP_POLICY_MISMATCH');

  const failedGates = Object.entries(report.observed.gates).filter(([, value]) => value === 'FAIL').map(([key]) => key);
  const missingGates = Object.entries(report.observed.gates).filter(([, value]) => value === 'NOT_RUN').map(([key]) => key);
  const failedChecks = CHECKS.filter((key) => report.observed.checks[key] === 'FAIL');
  const missingChecks = CHECKS.filter((key) => report.observed.checks[key] === 'NOT_RUN');
  const hardGate = ownershipViolations.length > 0 || failedGates.length > 0 || failedChecks.length > 0
    ? 'BLOCKED'
    : missingGates.length > 0 || missingChecks.length > 0
      ? 'INCOMPLETE'
      : 'READY_FOR_JEV';
  return { ownershipViolations, failedGates, missingGates, failedChecks, missingChecks, hardGate };
}

const rawChoiceSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1).max(128),
  probabilities: z.record(z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
}).passthrough();
const rawNoulSchema = z.object({ type: z.literal('noul'), noul: z.number().finite().min(0).max(1) }).passthrough();
const rawResponseSchema = z.object({
  model: z.string().trim().min(1).max(128),
  answers: z.object({
    claim_integrity: rawChoiceSchema,
    suggested_lane: rawChoiceSchema,
    recovery_evidence_defect: rawNoulSchema,
    error_privacy_defect: rawNoulSchema,
    preflight_side_effect_defect: rawNoulSchema,
    pending_reconciliation_defect: rawNoulSchema,
    test_quality_defect: rawNoulSchema,
  }).strict(),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).strict(),
}).passthrough();

function choice<T extends string>(raw: z.infer<typeof rawChoiceSchema>, options: readonly T[]): ChoiceJudgment<T> | undefined {
  if (!options.includes(raw.choice as T)) return undefined;
  const actual = Object.keys(raw.probabilities).sort();
  const expected = [...options].sort();
  if (actual.length !== expected.length || expected.some((key, index) => key !== actual[index])) return undefined;
  let total = 0;
  const probabilities = {} as Record<T, number>;
  for (const option of options) {
    const probability = raw.probabilities[option];
    if (!Number.isFinite(probability)) return undefined;
    probabilities[option] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.000_001) return undefined;
  return { choice: raw.choice as T, confidence: raw.confidence, probabilities };
}

function requestBody(report: SupervisorCheckpoint, deterministic: SupervisorDeterministicState, model: string): string {
  const defectQuestion = (instructions: string) => ({
    type: 'noul',
    instructions,
    criteria: {
      true: 'The checkpoint claims or unresolved risks indicate this defect remains, is weakly tested, or is not evidenced as fixed.',
      false: 'The checkpoint contains specific, internally consistent local evidence that this defect is fixed and regression-tested.',
    },
  });
  return JSON.stringify({
    model,
    state: {
      checkpoint: report,
      deterministic,
      policy: [
        'Jev is advisory and cannot edit source, merge, deploy, broadcast, sign, or authorize release.',
        'Deterministic ownership and gate failures cannot be overridden by a model answer.',
        'Local fixtures and tests are not live Testnet evidence.',
        'Choose a correction lane when claims exceed the sanitized observations or a defect remains plausible.',
      ],
    },
    questions: {
      claim_integrity: {
        type: 'choice',
        instructions: 'Are `state.checkpoint.observed.claims` supported by the other sanitized checkpoint facts?',
        criteria: {
          SUPPORTED: 'Every claim stays within the observed gates, checks, changed paths, and local-only evidence boundary.',
          OVERSTATED: 'At least one claim exceeds the observed evidence or treats a local/prepared result as an external fact.',
          INSUFFICIENT_EVIDENCE: 'The checkpoint lacks enough specific information to judge one or more material claims.',
        },
      },
      suggested_lane: {
        type: 'choice',
        instructions: 'Which bounded lane should receive this checkpoint next? This is advice only; code applies stricter policy.',
        criteria: {
          CORRECT_IMPLEMENTER_06: 'Production provider-runner behavior or its owned regression tests need another implementation round.',
          START_REVIEWER_07: 'Implementation evidence is coherent enough for the independent test-only adversarial reviewer.',
          CORRECT_REVIEWER_07: 'The independent reviewer test/report itself is incomplete or outside its one-file ownership.',
          PLATFORM_LEAD_REVIEW: 'The issue is cross-cutting, ambiguous, conflicts with ownership, or needs a human/Codex decision.',
        },
      },
      recovery_evidence_defect: defectQuestion('Does the checkpoint leave a material risk that recovery can publish caller-authored transfer facts as finalized evidence?'),
      error_privacy_defect: defectQuestion('Does the checkpoint leave a material risk that collaborator-controlled or sensitive text reaches public errors, steps, or evidence?'),
      preflight_side_effect_defect: defectQuestion('Does the checkpoint leave a material risk that an invalid token/spec reaches private work, transfer, or signing side effects before rejection?'),
      pending_reconciliation_defect: defectQuestion('Does the checkpoint leave a material risk that a known broadcast hash is discarded or mislabeled while its receipt is pending or conflicting?'),
      test_quality_defect: defectQuestion('Do the checkpoint tests appear too weak, fixture-circular, or incomplete to support the implementation claims?'),
    },
  });
}

const DIRECTIVES: Readonly<Record<SupervisorCheck, string>> = {
  recoveryEvidence: 'Re-open Prompt 06 section 1: reconstruct transfer evidence from two finalized RPC observations; never copy caller-authored evidence fields.',
  errorPrivacy: 'Re-open Prompt 06 section 2: replace collaborator-controlled public text with stable runner-authored codes/messages and add literal-marker leak tests.',
  preflightSideEffects: 'Re-open Prompt 06 section 3: reject token/spec mismatch before private input, executor, transfer, signer, or other side effects; prove zero calls with spies.',
  pendingReconciliation: 'Re-open Prompt 06 section 4: retain a known broadcast hash in structured non-final evidence and reconcile without blind resend.',
  testQuality: 'Strengthen adversarial tests with independently constructed fixtures, negative controls, two-RPC disagreement, and assertions on externally observable output.',
};

function deterministicCorrections(state: SupervisorDeterministicState): string[] {
  const corrections: string[] = [];
  if (state.ownershipViolations.length > 0) corrections.push(`Stop and restore ownership boundaries; out-of-scope paths: ${state.ownershipViolations.join(', ')}`);
  if (state.failedGates.length > 0) corrections.push(`Fix and rerun failed deterministic gates: ${state.failedGates.join(', ')}`);
  if (state.missingGates.length > 0) corrections.push(`Run missing deterministic gates: ${state.missingGates.join(', ')}`);
  for (const check of state.failedChecks) corrections.push(DIRECTIVES[check]);
  for (const check of state.missingChecks) corrections.push(`Produce fresh evidence for ${check}; do not infer PASS from another test.`);
  return corrections;
}

function route(
  report: SupervisorCheckpoint,
  deterministic: SupervisorDeterministicState,
  assessment?: SupervisorJevAssessment,
): { nextAction: SupervisorNextAction; corrections: string[] } {
  const corrections = deterministicCorrections(deterministic);
  if (deterministic.hardGate !== 'READY_FOR_JEV') {
    if (report.stage === 'IMPLEMENTER_06') {
      return { nextAction: 'RETURN_TO_IMPLEMENTER_06', corrections };
    }
    const productionChecks: readonly SupervisorCheck[] = [
      'recoveryEvidence',
      'errorPrivacy',
      'preflightSideEffects',
      'pendingReconciliation',
    ];
    if (deterministic.failedChecks.some((check) => productionChecks.includes(check))) {
      return { nextAction: 'RETURN_TO_IMPLEMENTER_06', corrections };
    }
    if (
      deterministic.ownershipViolations.length > 0 ||
      deterministic.failedChecks.includes('testQuality') ||
      deterministic.missingChecks.length > 0 ||
      deterministic.missingGates.length > 0
    ) {
      return { nextAction: 'RETURN_TO_REVIEWER_07', corrections };
    }
    return {
      nextAction: 'HUMAN_REVIEW_REQUIRED',
      corrections,
    };
  }
  if (!assessment) return { nextAction: 'HUMAN_REVIEW_REQUIRED', corrections: ['Jev is unavailable; Codex and the human release owner must review this checkpoint manually.'] };

  const defectEntries = Object.entries(assessment.defectProbability) as [SupervisorCheck, number][];
  const likelyDefects = defectEntries.filter(([, probability]) => probability >= 0.5);
  for (const [check, probability] of likelyDefects) corrections.push(`${DIRECTIVES[check]} Jev yes-probability=${probability.toFixed(3)}.`);
  if (assessment.claimIntegrity.choice !== 'SUPPORTED') {
    corrections.push(`Rewrite or substantiate checkpoint claims; Jev classified claim integrity as ${assessment.claimIntegrity.choice}.`);
  }

  const likelyProductionDefects = likelyDefects.filter(([check]) => check !== 'testQuality');
  const likelyTestQualityDefect = likelyDefects.some(([check]) => check === 'testQuality');
  if (likelyProductionDefects.length > 0) {
    return { nextAction: 'RETURN_TO_IMPLEMENTER_06', corrections };
  }
  if (likelyTestQualityDefect || assessment.claimIntegrity.choice === 'OVERSTATED') {
    return {
      nextAction: report.stage === 'IMPLEMENTER_06' ? 'RETURN_TO_IMPLEMENTER_06' : 'RETURN_TO_REVIEWER_07',
      corrections,
    };
  }
  if (assessment.claimIntegrity.choice === 'INSUFFICIENT_EVIDENCE' || assessment.suggestedLane.confidence < 0.6) {
    return { nextAction: 'HUMAN_REVIEW_REQUIRED', corrections };
  }
  if (report.stage === 'IMPLEMENTER_06') {
    return assessment.suggestedLane.choice === 'START_REVIEWER_07'
      ? { nextAction: 'START_REVIEWER_07', corrections }
      : assessment.suggestedLane.choice === 'CORRECT_IMPLEMENTER_06'
        ? { nextAction: 'RETURN_TO_IMPLEMENTER_06', corrections }
        : { nextAction: 'HUMAN_REVIEW_REQUIRED', corrections };
  }
  return assessment.suggestedLane.choice === 'CORRECT_REVIEWER_07'
    ? { nextAction: 'RETURN_TO_REVIEWER_07', corrections }
    : assessment.suggestedLane.choice === 'CORRECT_IMPLEMENTER_06'
      ? { nextAction: 'RETURN_TO_IMPLEMENTER_06', corrections }
      : { nextAction: 'HUMAN_RELEASE_REVIEW', corrections };
}

function modelFrom(environment: NodeJS.ProcessEnv): string | undefined {
  const model = (environment.TYPESAFE_MODEL ?? 'jev-latest').trim();
  return model.length > 0 && model.length <= 128 && !/\s/.test(model) && isSafeText(model) ? model : undefined;
}

function unavailable(report: SupervisorCheckpoint, deterministic: SupervisorDeterministicState, reason: SupervisorUnavailableReason): SupervisorResult {
  const routed = route(report, deterministic);
  return {
    schema: SUPERVISOR_RESULT_SCHEMA,
    status: 'UNAVAILABLE',
    checkpointDigest: hashJSON(report),
    deterministic,
    nextAction: routed.nextAction,
    correctionPacket: routed.corrections,
    reason,
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runJevBuildSupervisor(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<SupervisorResult> {
  const report = parseSupervisorCheckpoint(input);
  const deterministic = inspectSupervisorCheckpoint(report);
  if (deterministic.hardGate !== 'READY_FOR_JEV') {
    const reason = deterministic.hardGate === 'BLOCKED'
      ? 'DETERMINISTIC_GATE_BLOCKED'
      : 'DETERMINISTIC_EVIDENCE_INCOMPLETE';
    return unavailable(report, deterministic, reason);
  }

  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return unavailable(report, deterministic, 'TYPESAFE_API_KEY_MISSING');
  const model = modelFrom(environment);
  if (!model) return unavailable(report, deterministic, 'TYPESAFE_MODEL_INVALID');
  const body = requestBody(report, deterministic, model);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(TYPESAFE_SYSTEM_ONE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'JEV_TIMEOUT' : 'JEV_REQUEST_FAILED';
      return unavailable(report, deterministic, reason);
    }
    if ((response.status === 429 || response.status === 529) && attempt < 2) {
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (response.status === 401) return unavailable(report, deterministic, 'JEV_AUTH_FAILED');
    if (response.status === 422) return unavailable(report, deterministic, 'JEV_REQUEST_INVALID');
    if (response.status === 429) return unavailable(report, deterministic, 'JEV_RATE_LIMITED');
    if (response.status === 529) return unavailable(report, deterministic, 'JEV_SERVICE_UNAVAILABLE');
    if (!response.ok) return unavailable(report, deterministic, 'JEV_HTTP_ERROR');

    let decoded: unknown;
    try { decoded = await response.json(); } catch { return unavailable(report, deterministic, 'JEV_RESPONSE_INVALID'); }
    const parsed = rawResponseSchema.safeParse(decoded);
    if (!parsed.success || !isSafeText(parsed.data.model)) return unavailable(report, deterministic, 'JEV_RESPONSE_INVALID');
    const claimIntegrity = choice(parsed.data.answers.claim_integrity, CLAIM_OPTIONS);
    const suggestedLane = choice(parsed.data.answers.suggested_lane, JEV_LANES);
    if (!claimIntegrity || !suggestedLane) return unavailable(report, deterministic, 'JEV_RESPONSE_INVALID');
    const assessment: SupervisorJevAssessment = {
      provider: 'typesafe',
      model: parsed.data.model,
      claimIntegrity,
      suggestedLane,
      defectProbability: {
        recoveryEvidence: parsed.data.answers.recovery_evidence_defect.noul,
        errorPrivacy: parsed.data.answers.error_privacy_defect.noul,
        preflightSideEffects: parsed.data.answers.preflight_side_effect_defect.noul,
        pendingReconciliation: parsed.data.answers.pending_reconciliation_defect.noul,
        testQuality: parsed.data.answers.test_quality_defect.noul,
      },
    };
    const routed = route(report, deterministic, assessment);
    return {
      schema: SUPERVISOR_RESULT_SCHEMA,
      status: 'AVAILABLE',
      checkpointDigest: hashJSON(report),
      deterministic,
      assessment,
      nextAction: routed.nextAction,
      correctionPacket: routed.corrections,
    };
  }
  return unavailable(report, deterministic, 'JEV_SERVICE_UNAVAILABLE');
}
