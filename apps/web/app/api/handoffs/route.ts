import { handoffStore, type HandoffKind } from '../../../lib/server/handoff-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const reply = (body: unknown, status: number) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(request: Request): Promise<Response> {
  const length = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(length) || length > 100 * 1024) return reply({ error: 'HANDOFF_BODY_TOO_LARGE' }, 413);
  let body: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 100 * 1024) return reply({ error: 'HANDOFF_BODY_TOO_LARGE' }, 413);
    body = JSON.parse(text);
  } catch { return reply({ error: 'HANDOFF_BODY_INVALID' }, 400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ error: 'HANDOFF_BODY_INVALID' }, 400);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'ciphertext,expiresAt,iv,kind') return reply({ error: 'HANDOFF_BODY_INVALID' }, 400);
  try {
    const stored = handoffStore().create({ kind: value.kind as HandoffKind, iv: String(value.iv ?? ''), ciphertext: String(value.ciphertext ?? ''), expiresAt: Number(value.expiresAt) });
    return reply({ id: stored.id, kind: stored.kind, createdAt: stored.createdAt, expiresAt: stored.expiresAt }, 201);
  } catch (error) {
    return reply({ error: error instanceof Error ? error.message : 'HANDOFF_WRITE_FAILED' }, 400);
  }
}
