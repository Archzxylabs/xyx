/**
 * `GET /api/operations/[id]` — read one operation's lifecycle state.
 * `PATCH /api/operations/[id]` — mutate operation state with strict validation.
 *
 * The status this route reports is the durable one. There is no path by which a
 * GET can cause a transition. Finality is reached only through reconciliation,
 * which requires two independent RPC observations that agree.
 *
 * @module operations-api
 */

import {
  assertKnownFields,
  assertNoSecrets,
  OperationError,
  OperationStoreError,
  toPublicOperationRecord,
  validateTransactionHash,
  type OperationFailureCode,
  type OperationPublicRecord,
  type OperationStatus,
  type ReceiptObservation,
  type TransitionDetail,
} from '../../../../../../packages/monad/src/operations/index';
import {
  isOperationJournalConfigured,
  isOperationJournalOpen,
  operationJournal,
  OperationsConfigurationError,
} from '../../../../lib/server/operations/journal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const reply = (body: unknown, status: number): Response => Response.json(body, { status, headers: NO_STORE });

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isOperationJournalOpen() && !isOperationJournalConfigured()) {
    return reply({ error: 'OPERATIONS_JOURNAL_NOT_CONFIGURED', message: 'no durable operation journal is open' }, 503);
  }

  const { id } = await context.params;
  if (typeof id !== 'string' || id.length < 8 || id.length > 128) {
    return reply({ error: 'OPERATION_ID_INVALID' }, 400);
  }

  try {
    const journal = operationJournal();
    const record = journal.read(id);
    if (!record) {
      return reply({ error: 'OPERATION_NOT_FOUND' }, 404);
    }
    const capability = request.headers.get('x-operation-capability')
      ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (!capability) {
      return reply({ error: 'CAPABILITY_REQUIRED', message: 'operation capability token is required' }, 401);
    }
    if (!journal.verifyCapability(id, capability)) {
      return reply({ error: 'CAPABILITY_INVALID', message: 'invalid operation capability token' }, 403);
    }
    const projected: OperationPublicRecord = toPublicOperationRecord(record);
    return reply({
      id: projected.id,
      status: projected.status,
      kind: projected.kind,
      actorAddress: projected.actorAddress,
      actorRole: projected.actorRole,
      jobId: projected.jobId,
      transactionHash: projected.transactionHash,
      reconciliation: projected.reconciliation,
      finality: projected.finality,
      failureCode: projected.failureCode,
      diagnostic: projected.diagnostic,
      updatedAt: projected.updatedAt,
    }, 200);
  } catch (error) {
    if (error instanceof OperationsConfigurationError) {
      return reply({ error: error.code, message: error.message }, 503);
    }
    return reply(
      { error: 'OPERATION_READ_FAILED', message: error instanceof Error ? error.message : 'unavailable' },
      500
    );
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isOperationJournalConfigured()) {
    return reply(
      { error: 'OPERATIONS_STORAGE_PATH_REQUIRED', message: 'no durable operation journal is configured' },
      503
    );
  }

  const { id } = await context.params;
  if (typeof id !== 'string' || id.length < 8 || id.length > 128) {
    return reply({ error: 'OPERATION_ID_INVALID' }, 400);
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
    assertKnownFields(recordBody, ['action', 'transactionHash', 'observation', 'to', 'detail', 'code', 'diagnostic', 'outcome', 'capabilityToken']);

    const journal = operationJournal();
    const existing = journal.read(id);
    if (!existing) {
      return reply({ error: 'OPERATION_NOT_FOUND', message: `no operation with id ${id} exists` }, 404);
    }

    const capability = request.headers.get('x-operation-capability')
      ?? request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      ?? (typeof recordBody.capabilityToken === 'string' ? recordBody.capabilityToken : null);
    if (!capability) {
      return reply({ error: 'CAPABILITY_REQUIRED', message: 'operation capability token is required' }, 401);
    }

    if (!journal.verifyCapability(id, capability)) {
      return reply({ error: 'CAPABILITY_INVALID', message: 'invalid operation capability token' }, 403);
    }

    const action = recordBody.action;
    let updated;

    switch (action) {
      case 'RECORD_HASH': {
        const hash = validateTransactionHash(recordBody.transactionHash);
        updated = journal.recordTransactionHash(id, hash);
        break;
      }
      case 'ADD_OBSERVATION': {
        const obs = recordBody.observation as ReceiptObservation;
        if (!obs || typeof obs !== 'object' || !obs.source || !obs.rpc || typeof obs.blockNumber !== 'number' || !obs.blockHash || !obs.status) {
          return reply({ error: 'INVALID_OBSERVATION', message: 'valid observation object is required' }, 400);
        }
        updated = journal.addObservation(id, obs);
        break;
      }
      case 'RECONCILE': {
        updated = journal.reconcile(id);
        break;
      }
      case 'TRANSITION': {
        const to = recordBody.to as OperationStatus;
        const detail = (recordBody.detail ?? {}) as TransitionDetail;
        if (to === 'FINALIZED') {
          const current = journal.read(id);
          if (current?.reconciliation !== 'AGREED') {
            return reply(
              {
                error: 'RECONCILIATION_NOT_AGREED',
                message: `operation ${id} cannot be FINALIZED without agreed reconciliation (current: ${current?.reconciliation ?? 'NOT_STARTED'})`,
              },
              400
            );
          }
        }
        updated = journal.transition(id, to, detail);
        break;
      }
      case 'FAIL': {
        const code = recordBody.code as OperationFailureCode;
        const diagnostic = typeof recordBody.diagnostic === 'string' ? recordBody.diagnostic : '';
        updated = journal.fail(id, code, diagnostic);
        break;
      }
      case 'RESOLVE_AMBIGUOUS': {
        const outcome = recordBody.outcome as OperationStatus;
        const diagnostic = typeof recordBody.diagnostic === 'string' ? recordBody.diagnostic : '';
        updated = journal.resolveAmbiguous(id, outcome, diagnostic);
        break;
      }
      default:
        return reply({ error: 'ACTION_INVALID', message: `unsupported action: ${String(action)}` }, 400);
    }

    const projected = toPublicOperationRecord(updated);
    return reply(projected, 200);
  } catch (error) {
    if (error instanceof OperationError || error instanceof OperationStoreError) {
      return reply({ error: error.code, message: error.message }, 400);
    }
    if (error instanceof OperationsConfigurationError) {
      return reply({ error: error.code, message: error.message }, 503);
    }
    return reply(
      { error: 'OPERATION_UPDATE_FAILED', message: error instanceof Error ? error.message : 'unavailable' },
      500
    );
  }
}
