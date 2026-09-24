/**
 * `GET /api/operations/[id]` — read one operation's lifecycle state.
 *
 * The status this route reports is the durable one. There is no endpoint that
 * marks an operation FINALIZED, and there is deliberately no path by which a
 * GET can cause a transition. Finality is reached only through reconciliation,
 * which requires two independent RPC observations that agree — a request
 * against this route can read that conclusion but never produce one.
 *
 * @module operations-api
 */

import {
  toPublicOperationRecord,
  type OperationPublicRecord,
} from '../../../../../../packages/monad/src/operations/index';
import {
  isOperationJournalOpen,
  operationJournal,
  OperationsConfigurationError,
} from '../../../../lib/server/operations/journal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;

const reply = (body: unknown, status: number): Response => Response.json(body, { status, headers: NO_STORE });

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!isOperationJournalOpen()) {
    return reply({ error: 'OPERATIONS_JOURNAL_NOT_CONFIGURED', message: 'no durable operation journal is open' }, 503);
  }

  const { id } = await context.params;
  if (typeof id !== 'string' || id.length < 8 || id.length > 128) {
    return reply({ error: 'OPERATION_ID_INVALID' }, 400);
  }

  try {
    const record = operationJournal().read(id);
    if (!record) {
      return reply({ error: 'OPERATION_NOT_FOUND' }, 404);
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
