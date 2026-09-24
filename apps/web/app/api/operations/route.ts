/**
 * `GET /api/operations` — list operations.
 *
 * Read-only and intentionally thin. The response is a list of
 * `OperationPublicRecord` projections, which is the only form an operation may
 * leave the server in: no calldata, no signed material, no storage credential.
 *
 * There is deliberately no `POST /api/operations`. Operations are created by a
 * caller that already holds a capability in the browser layer, and a server
 * endpoint that could mint operations would let any caller drive the lifecycle
 * without one. This service exists to report lifecycle state, not to assert it.
 *
 * @module operations-api
 */

import {
  toPublicOperationRecord,
  type OperationPublicRecord,
} from '../../../../../packages/monad/src/operations/index';
import {
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
   * `false` when no journal is open. This is truthfulness, not a failure: a
   * server with no configured journal has no operations to report, and must
   * not present that as an empty durable journal.
   */
  readonly durableJournalOpen: boolean;
}

export async function GET(_request: Request): Promise<Response> {
  if (!isOperationJournalOpen()) {
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
    // A configuration failure is a distinct, actionable answer. It names the
    // variable to set and nothing else — never a path that may embed a secret.
    if (error instanceof OperationsConfigurationError) {
      return reply({ error: error.code, message: error.message, durableJournalOpen: false }, 503);
    }
    return reply(
      { error: 'OPERATIONS_LIST_FAILED', message: error instanceof Error ? error.message : 'unavailable' },
      500
    );
  }
}
