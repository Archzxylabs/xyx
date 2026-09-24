import { canonicalJSON } from '../../../packages/monad/src/canonical';

export type SecureHandoffKind = 'terms' | 'delivery' | 'evidence';
const ID = /^[A-Za-z0-9_-]{32}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encode(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) throw new Error('HANDOFF_ENCODING_INVALID');
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('HANDOFF_RESPONSE_INVALID');
  return value as Record<string, unknown>;
}

export async function createSecureHandoff(kind: SecureHandoffKind, payload: unknown): Promise<string> {
  if (typeof window === 'undefined' || !window.isSecureContext) throw new Error('SECURE_CONTEXT_REQUIRED');
  const plaintext = new TextEncoder().encode(canonicalJSON(payload));
  if (plaintext.byteLength > 64 * 1024) throw new Error('HANDOFF_PAYLOAD_TOO_LARGE');
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
  const response = await fetch('/api/handoffs', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, iv: encode(iv), ciphertext: encode(ciphertext), expiresAt }),
  });
  const result = record(await response.json().catch(() => null));
  if (!response.ok || typeof result.id !== 'string' || !ID.test(result.id)) throw new Error(typeof result.error === 'string' ? result.error : 'HANDOFF_WRITE_FAILED');
  const url = new URL('/reference', window.location.origin);
  url.searchParams.set('handoff', result.id);
  url.hash = new URLSearchParams({ handoffKey: encode(rawKey), handoffKind: kind }).toString();
  return url.toString();
}

export async function readSecureHandoff(link: string, expectedKind: SecureHandoffKind): Promise<unknown> {
  if (typeof window === 'undefined' || !window.isSecureContext) throw new Error('SECURE_CONTEXT_REQUIRED');
  let url: URL;
  try { url = new URL(link, window.location.origin); } catch { throw new Error('HANDOFF_LINK_INVALID'); }
  if (url.origin !== window.location.origin || url.pathname !== '/reference') throw new Error('HANDOFF_LINK_INVALID');
  const id = url.searchParams.get('handoff') ?? '';
  const fragment = new URLSearchParams(url.hash.slice(1));
  const encodedKey = fragment.get('handoffKey') ?? '';
  if (!ID.test(id) || fragment.get('handoffKind') !== expectedKind) throw new Error('HANDOFF_LINK_INVALID');
  const rawKey = decode(encodedKey);
  if (rawKey.byteLength !== 32) throw new Error('HANDOFF_KEY_INVALID');
  const response = await fetch(`/api/handoffs/${encodeURIComponent(id)}`, { cache: 'no-store' });
  const result = record(await response.json().catch(() => null));
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'HANDOFF_READ_FAILED');
  if (result.kind !== expectedKind || typeof result.iv !== 'string' || typeof result.ciphertext !== 'string') throw new Error('HANDOFF_RESPONSE_INVALID');
  try {
    const key = await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['decrypt']);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(result.iv) }, key, decode(result.ciphertext));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
  } catch {
    throw new Error('HANDOFF_DECRYPTION_FAILED');
  }
}
