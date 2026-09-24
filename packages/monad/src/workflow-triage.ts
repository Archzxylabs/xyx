/**
 * Real-only Jev workflow triage for the XYX engineering process.
 *
 * This module does not change a contract, deploy, sign, merge, or authorize an
 * external action. Deterministic release facts stay in code; Jev is asked only
 * to classify the integrity of a sanitized implementation report and the
 * review lane that Codex should inspect next.
 *
 * There is deliberately no mock, fixture, fallback model, or synthesized
 * AVAILABLE result. Without a real TypeSafe response, the only result is
 * UNAVAILABLE.
 */

import { z } from 'zod';
import { hashJSON } from './canonical';

export const WORKFLOW_REPORT_SCHEMA = 'xyx.agent-work-report.v1' as const;
export const WORKFLOW_TRIAGE_SCHEMA = 'xyx.jev-workflow-triage.v1' as const;
export const TYPESAFE_SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone' as const;

const REVIEW_LANES = [
  'CONTRACT_SECURITY',
  'SDK_ABI',
  'WEB_TRUTHFULNESS',
  'CHAIN_OPERATIONS',
  'DOCS_PRODUCT',
  'PLATFORM_LEAD',
] as const;

const CLAIM_INTEGRITY_OPTIONS = ['SUPPORTED', 'OVERSTATED', 'INSUFFICIENT_EVIDENCE'] as const;

export type WorkflowReviewLane = (typeof REVIEW_LANES)[number];
export type ClaimIntegrity = (typeof CLAIM_INTEGRITY_OPTIONS)[number];
export type WorkflowHardGate =
  | 'BLOCKED'
  | 'INCOMPLETE_LOCAL_EVIDENCE'
  | 'LOCAL_EVIDENCE_ONLY'
  | 'HUMAN_REVIEW_REQUIRED';

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

function safeText(value: string, field: string): void {
  if (SENSITIVE_TEXT.some((pattern) => pattern.test(value))) {
    throw new Error(`WORKFLOW_REPORT_SENSITIVE_${field.toUpperCase()}`);
  }
}

const boundedText = (max: number, field: string) =>
  z.string().trim().min(1).max(max).superRefine((value, context) => {
    try {
      safeText(value, field);
    } catch {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'sensitive text is not allowed' });
    }
  });

/**
 * Changed files stay inside the repository: a leading `/` is refused so an
 * absolute host path can never be reported, and `..` segments are refused.
 */
const changedFile = z.string().trim().min(1).max(180).regex(
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/@-]+$/,
  'must be a repository-relative path',
);

const gateSchema = z.enum(['PASS', 'FAIL', 'NOT_RUN']);

/**
 * The only report shape that may leave the repository for Jev triage.
 * It intentionally has no source code, environment values, URLs, hashes,
 * credentials, transaction IDs, private evidence, or raw command output.
 */
export const workflowReportSchema = z.object({
  schema: z.literal(WORKFLOW_REPORT_SCHEMA),
  task: z.object({
    id: boundedText(80, 'task_id'),
    title: boundedText(240, 'task_title'),
    areas: z.array(z.enum(REVIEW_LANES)).min(1).max(3),
  }).strict(),
  observed: z.object({
    filesChanged: z.array(changedFile).max(80),
    gates: z.object({
      contracts: gateSchema,
      node: gateSchema,
      typecheck: gateSchema,
      web: gateSchema,
    }).strict(),
    testnet: z.object({
      deploymentObserved: z.boolean(),
      broadcastObserved: z.boolean(),
      receiptObserved: z.boolean(),
      sourceVerificationObserved: z.boolean(),
    }).strict(),
    unresolvedRisks: z.array(boundedText(360, 'unresolved_risk')).max(20),
  }).strict(),
  claims: z.array(boundedText(360, 'claim')).min(1).max(20),
  proposedNextStep: boundedText(360, 'proposed_next_step'),
}).strict();

export type WorkflowReport = z.infer<typeof workflowReportSchema>;

export interface ChoiceJudgment<T extends string> {
  choice: T;
  confidence: number;
  probabilities: Record<T, number>;
}

export interface JevWorkflowAssessment {
  provider: 'typesafe';
  model: string;
  claimIntegrity: ChoiceJudgment<ClaimIntegrity>;
  reviewLane: ChoiceJudgment<WorkflowReviewLane>;
}

export type WorkflowTriageResult =
  | {
      schema: typeof WORKFLOW_TRIAGE_SCHEMA;
      status: 'AVAILABLE';
      reportDigest: `0x${string}`;
      hardGate: WorkflowHardGate;
      assessment: JevWorkflowAssessment;
    }
  | {
      schema: typeof WORKFLOW_TRIAGE_SCHEMA;
      status: 'UNAVAILABLE';
      reportDigest: `0x${string}`;
      hardGate: WorkflowHardGate;
      reason:
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
    };

/** Parse and redact-fail a report before any network request is possible. */
export function parseWorkflowReport(value: unknown): WorkflowReport {
  const parsed = workflowReportSchema.safeParse(value);
  if (!parsed.success) throw new Error('WORKFLOW_REPORT_INVALID');
  return parsed.data;
}

/**
 * Deterministic policy is never delegated to Jev. A model recommendation cannot
 * upgrade a failed gate, incomplete gate set, or local-only evidence state.
 */
export function determineWorkflowHardGate(report: WorkflowReport): WorkflowHardGate {
  const gateValues = Object.values(report.observed.gates);
  if (gateValues.includes('FAIL')) return 'BLOCKED';
  if (gateValues.includes('NOT_RUN')) return 'INCOMPLETE_LOCAL_EVIDENCE';

  const { deploymentObserved, broadcastObserved, receiptObserved, sourceVerificationObserved } = report.observed.testnet;
  if (!deploymentObserved || !broadcastObserved || !receiptObserved || !sourceVerificationObserved) {
    return 'LOCAL_EVIDENCE_ONLY';
  }
  return 'HUMAN_REVIEW_REQUIRED';
}

const rawChoiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string().min(1).max(128),
  probabilities: z.record(z.number().finite().min(0).max(1)),
  confidence: z.number().finite().min(0).max(1),
}).passthrough();

const rawSystemOneResponseSchema = z.object({
  model: z.string().trim().min(1).max(128),
  answers: z.object({
    claim_integrity: rawChoiceAnswerSchema,
    review_lane: rawChoiceAnswerSchema,
  }).strict(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }).strict(),
}).passthrough();

function parseChoiceJudgment<T extends string>(
  raw: z.infer<typeof rawChoiceAnswerSchema>,
  options: readonly T[],
): ChoiceJudgment<T> | undefined {
  if (!options.includes(raw.choice as T)) return undefined;
  const expectedKeys = [...options].sort();
  const actualKeys = Object.keys(raw.probabilities).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((option, index) => option !== actualKeys[index])) {
    return undefined;
  }

  const probabilities = {} as Record<T, number>;
  let total = 0;
  for (const option of options) {
    const probability = raw.probabilities[option];
    if (!Number.isFinite(probability) || probability < 0 || probability > 1) return undefined;
    probabilities[option] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.000_001) return undefined;

  return { choice: raw.choice as T, confidence: raw.confidence, probabilities };
}

function unavailable(
  report: WorkflowReport,
  reason: Extract<WorkflowTriageResult, { status: 'UNAVAILABLE' }>['reason'],
): WorkflowTriageResult {
  return {
    schema: WORKFLOW_TRIAGE_SCHEMA,
    status: 'UNAVAILABLE',
    reportDigest: hashJSON(report),
    hardGate: determineWorkflowHardGate(report),
    reason,
  };
}

function modelFrom(environment: NodeJS.ProcessEnv): string | undefined {
  const value = (environment.TYPESAFE_MODEL ?? 'jev-latest').trim();
  if (value.length === 0 || value.length > 128 || /\s/.test(value) || SENSITIVE_TEXT.some((pattern) => pattern.test(value))) {
    return undefined;
  }
  return value;
}

function requestBody(report: WorkflowReport, hardGate: WorkflowHardGate, model: string): string {
  return JSON.stringify({
    model,
    state: {
      report,
      deterministicPolicy: {
        hardGate,
        rules: [
          'Only observed receipts and contract state may support a live Testnet claim.',
          'A local test pass is not live deployment, broadcast, receipt, or source-verification evidence.',
          'Jev is advisory only and cannot authorize merge, deploy, broadcast, or settlement.',
        ],
      },
    },
    questions: {
      claim_integrity: {
        type: 'choice',
        instructions:
          'Classify whether `state.report.claims` are justified by `state.report.observed`. A live claim without observed deployment, broadcast, receipt, and source verification is overstated. Choose INSUFFICIENT_EVIDENCE when the report lacks facts needed to judge the claims.',
        criteria: {
          SUPPORTED: 'Every claim stays within the observed facts and clearly distinguishes local checks from live evidence.',
          OVERSTATED: 'One or more claims exceed the observed evidence or present local/prepared work as an external fact.',
          INSUFFICIENT_EVIDENCE: 'The report does not contain enough information to determine whether its claims are justified.',
        },
      },
      review_lane: {
        type: 'choice',
        instructions:
          'Select the single review lane Codex should inspect next, based on `state.report.task`, `state.report.observed`, and `state.report.claims`. Choose PLATFORM_LEAD when no specialised lane is clearly justified.',
        criteria: {
          CONTRACT_SECURITY: 'Solidity lifecycle, authorization, token accounting, signatures, ABI, or adversarial test risk.',
          SDK_ABI: 'TypeScript SDK contract binding, schema, calldata, event, commitment, or verifier risk.',
          WEB_TRUTHFULNESS: 'Browser UI, public claims, explorer links, display state, or client-secret risk.',
          CHAIN_OPERATIONS: 'Deployment, RPC, source verification, receipt, finality, configuration, or operational evidence risk.',
          DOCS_PRODUCT: 'PRD, blueprint, acceptance criteria, product scope, or documentation-code alignment risk.',
          PLATFORM_LEAD: 'Cross-cutting scope, ownership, sequencing, or evidence review requiring the project lead.',
        },
      },
    },
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Ask Jev over the official TypeSafe endpoint. This performs a real request
 * only after the report is validated and a non-empty server-side API key exists.
 * It never logs the request, response body, key, or caught error text.
 */
export async function runJevWorkflowTriage(
  input: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<WorkflowTriageResult> {
  const report = parseWorkflowReport(input);
  const apiKey = environment.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return unavailable(report, 'TYPESAFE_API_KEY_MISSING');

  const model = modelFrom(environment);
  if (!model) return unavailable(report, 'TYPESAFE_MODEL_INVALID');

  const hardGate = determineWorkflowHardGate(report);
  const body = requestBody(report, hardGate, model);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(TYPESAFE_SYSTEM_ONE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') return unavailable(report, 'JEV_TIMEOUT');
      return unavailable(report, 'JEV_REQUEST_FAILED');
    }

    if ((response.status === 429 || response.status === 529) && attempt < 2) {
      await sleep(250 * 2 ** attempt);
      continue;
    }
    if (response.status === 401) return unavailable(report, 'JEV_AUTH_FAILED');
    if (response.status === 422) return unavailable(report, 'JEV_REQUEST_INVALID');
    if (response.status === 429) return unavailable(report, 'JEV_RATE_LIMITED');
    if (response.status === 529) return unavailable(report, 'JEV_SERVICE_UNAVAILABLE');
    if (!response.ok) return unavailable(report, 'JEV_HTTP_ERROR');

    let decoded: unknown;
    try {
      decoded = await response.json();
    } catch {
      return unavailable(report, 'JEV_RESPONSE_INVALID');
    }
    const parsed = rawSystemOneResponseSchema.safeParse(decoded);
    if (!parsed.success) return unavailable(report, 'JEV_RESPONSE_INVALID');
    try {
      safeText(parsed.data.model, 'model');
    } catch {
      return unavailable(report, 'JEV_RESPONSE_INVALID');
    }

    const claimIntegrity = parseChoiceJudgment(parsed.data.answers.claim_integrity, CLAIM_INTEGRITY_OPTIONS);
    const reviewLane = parseChoiceJudgment(parsed.data.answers.review_lane, REVIEW_LANES);
    if (!claimIntegrity || !reviewLane) return unavailable(report, 'JEV_RESPONSE_INVALID');

    return {
      schema: WORKFLOW_TRIAGE_SCHEMA,
      status: 'AVAILABLE',
      reportDigest: hashJSON(report),
      hardGate,
      assessment: {
        provider: 'typesafe',
        model: parsed.data.model,
        claimIntegrity,
        reviewLane,
      },
    };
  }

  return unavailable(report, 'JEV_SERVICE_UNAVAILABLE');
}
