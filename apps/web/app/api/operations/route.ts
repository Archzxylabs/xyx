/**
 * `/api/operations` — list and create operations in the durable journal.
 *
 * Responses use `OperationPublicRecord` projections, which is the only form
 * an operation may leave the server in: no calldata, no signed material, no
 * private terms, and no storage credentials.
 *
 * Mutations validate every field strictly and reject secret-shaped or unknown
 * content before anything touches the journal.
 *
 * @module operations-api
 */

import { createHash, randomBytes } from 'node:crypto';

import {
  assertKnownFields,
  assertNoSecrets,
  OperationError,
  OperationStoreError,
  toPublicOperationRecord,
  validateActorRole,
  validateChainId,
  validateDeploymentBinding,
  validateIdempotencyKey,
  validateIntentDigest,
  validateNonce,
  validateOperationAddress,
  validateOperationKind,
  type OperationDeploymentBindingInput,
  type OperationPublicRecord,
} from '../../../../../packages/monad/src/operations/index';
import {
  isOperationJournalConfigured,
  isOperationJournalOpen,
  operationJournal,
  OperationsConfigurationError,
} from '../../../lib/server/operations/journal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const reply = (body: unknown, status: number): Response => Response.json(body, { status, headers: NO_STORE });

interface OperationsListResponse {
  readonly operations: readonly OperationPublicRecord[];
  /**
   * `false` when no journal is configured or open. This is truthfulness, not a failure: a
   * server with no configured journal has no operations to report, and must
   * not present that as an empty durable journal.
   */
  readonly durableJournalOpen: boolean;
}

export async function GET(_request: Request): Promise<Response> {
  const authHeader = _request.headers.get('authorization')
    ?? _request.headers.get('x-operations-internal')
    ?? _request.headers.get('x-operation-internal-key');
  const isBrowserRequest = _request.headers.get('sec-fetch-dest') !== null
    || _request.headers.get('sec-fetch-mode') !== null
    || Boolean(_request.headers.get('user-agent')?.includes('Mozilla'));

  if ((process.env.NODE_ENV === 'production' || isBrowserRequest) && !authHeader) {
    return reply(
      { error: 'UNAUTHORIZED', message: 'listing operations requires internal authentication' },
      401
    );
  }

  if (!isOperationJournalOpen() && !isOperationJournalConfigured()) {
    return reply({ operations: [], durableJournalOpen: false }, 200);
  }

  const url = new URL(_request.url);
  const rawLimit = url.searchParams.get('limit') ?? '100';
  const limit = Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    return reply({ error: 'OPERATIONS_LIMIT_INVALID' }, 400);
  }

  try {
    const journal = operationJournal();
    const operations = journal.list(limit).map(toPublicOperationRecord);
    return reply({ operations, durableJournalOpen: true } satisfies OperationsListResponse, 200);
  } catch (error) {
    if (error instanceof OperationsConfigurationError) {
      return reply({ error: error.code, message: error.message, durableJournalOpen: false }, 503);
    }
    return reply(
      { error: 'OPERATIONS_LIST_FAILED', message: error instanceof Error ? error.message : 'unavailable' },
      500
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!isOperationJournalConfigured()) {
    return reply(
      { error: 'OPERATIONS_STORAGE_PATH_REQUIRED', message: 'no durable operation journal is configured' },
      503
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ error: 'INVALID_JSON', message: 'request body must be valid JSON' }, 400);
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return reply({ error: 'INVALID_BODY', message: 'request body must be an object' }, 400);
  }

  const recordBody = body as Record<string, unknown>;

  try {
    assertNoSecrets(recordBody);
    assertKnownFields(recordBody, [
      'idempotencyKey',
      'kind',
      'actor',
      'actorRole',
      'expectedChainId',
      'deployment',
      'jobId',
      'intentDigest',
      'nonce',
    ]);

    const idempotencyKey = validateIdempotencyKey(recordBody.idempotencyKey);
    const kind = validateOperationKind(recordBody.kind);
    const actor = validateOperationAddress(recordBody.actor);
    const actorRole = validateActorRole(recordBody.actorRole);
    const expectedChainId = validateChainId(recordBody.expectedChainId);
    const deployment = validateDeploymentBinding(recordBody.deployment as OperationDeploymentBindingInput);
    const intentDigest = validateIntentDigest(recordBody.intentDigest);
    const jobId = recordBody.jobId !== undefined && recordBody.jobId !== null
      ? Number(recordBody.jobId)
      : null;
    const nonce = recordBody.nonce !== undefined && recordBody.nonce !== null
      ? validateNonce(recordBody.nonce)
      : null;

    const journal = operationJournal();
    const created = journal.create({
      idempotencyKey,
      kind,
      actor,
      actorRole,
      expectedChainId,
      deployment,
      jobId,
      intentDigest,
      nonce,
    });

    const capabilityToken = `opcap_${randomBytes(24).toString('hex')}`;
    const capabilityHash = createHash('sha256').update(capabilityToken).digest('hex');
    journal.saveCapabilityHash(created.id, capabilityHash);

    const publicRecord = toPublicOperationRecord(created);
    return reply({
      ...publicRecord,
      capabilityToken,
    }, 201);
  } catch (error) {
    if (error instanceof OperationError || error instanceof OperationStoreError) {
      const status = error.code === 'IDEMPOTENCY_KEY_CONFLICT' ? 409 : 400;
      return reply({ error: error.code, message: error.message }, status);
    }
    if (error instanceof OperationsConfigurationError) {
      return reply({ error: error.code, message: error.message }, 503);
    }
    return reply(
      { error: 'OPERATION_CREATE_FAILED', message: error instanceof Error ? error.message : 'unavailable' },
      500
    );
  }
}
