import { handoffStore } from '../../../../lib/server/handoff-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  try {
    const stored = handoffStore().read(id);
    if (!stored) return Response.json({ error: 'HANDOFF_NOT_FOUND' }, { status: 404, headers: { 'cache-control': 'no-store' } });
    return Response.json({ kind: stored.kind, iv: stored.iv, ciphertext: stored.ciphertext, createdAt: stored.createdAt, expiresAt: stored.expiresAt }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'HANDOFF_READ_FAILED' }, { status: 400, headers: { 'cache-control': 'no-store' } });
  }
}
