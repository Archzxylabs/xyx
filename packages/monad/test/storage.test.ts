import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceStorage, PublicEvidenceReader, publicEvidenceReaderFromEnvironment } from '../src/storage.js';
import { canonicalJSON, hashJSON, hashText } from '../src/canonical.js';

// --- PublicEvidenceReader error paths ---

test('PublicEvidenceReader rejects invalid IPFS CID before fetch', async () => {
  const reader = new PublicEvidenceReader('http://127.0.0.1:9999');
  await assert.rejects(
    reader.readJSON('ipfs://babcdefghijklmnopqrstuvwxyz23456789', '0x'.repeat(64)),
    /INVALID_IPFS_CID/
  );
});

test('PublicEvidenceReader throws on non-200 gateway response', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 }) as never;
  const reader = new PublicEvidenceReader('http://127.0.0.1:9999');
  await assert.rejects(
    reader.readJSON('ipfs://babcdefghijklmnopqrstuvwxyz234567', '0x'.repeat(64)),
    /EVIDENCE_STORAGE_UNAVAILABLE/
  );
  globalThis.fetch = original;
});

// --- Canonical JSON equality ---

test('canonicalJSON produces different output for non-equivalent objects', () => {
  const a = { b: 2, a: 1, c: { z: 3, y: 2, x: 1 } };
  const b = { c: { x: 1, y: 2, z: 4 }, a: 1, b: 2 };
  assert.notEqual(canonicalJSON(a), canonicalJSON(b));
  assert.notEqual(hashJSON(a), hashJSON(b));
});

test('canonicalJSON rejects non-plain objects', () => {
  assert.throws(() => canonicalJSON(Object.create(null)), /NON_JSON_VALUE/);
  assert.throws(() => canonicalJSON(new Date()), /NON_JSON_VALUE/);
});

// --- Evidence hash and invalid JSON ---

test('invalid JSON with matching content hash is rejected as invalid, not hash mismatch', async () => {
  const text = 'not valid json';
  const expectedHash = hashText(text);
  const reader = new PublicEvidenceReader('http://127.0.0.1:9999');
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(text, { status: 200 }) as never;
  try {
    await assert.rejects(
      reader.readJSON(`ipfs://b${'a'.repeat(40)}`, expectedHash),
      /EVIDENCE_INVALID_JSON/
    );
  } finally {
    globalThis.fetch = original;
  }
});

test('evidence persistence mismatch is detected when readback differs', async () => {
  const storage = new EvidenceStorage({ provider: 'kubo', api: 'http://127.0.0.1:9999' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"different":"content"}', { status: 200 }) as never;
  try {
    await assert.rejects(storage.readJSON('ipfs://babcdefghijklmnopqrstuvwxyz234567', '0x'.repeat(64)), /EVIDENCE_HASH_MISMATCH/);
  } finally {
    globalThis.fetch = original;
  }
});

// --- Storage health checks ---

test('EvidenceStorage health fails on unreachable Kubo API', async () => {
  const storage = new EvidenceStorage({ provider: 'kubo', api: 'http://127.0.0.1:9999' });
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { status: 503 }) as never;
  try {
    await assert.rejects(storage.health(), /EVIDENCE_STORAGE_UNAVAILABLE/);
  } finally {
    globalThis.fetch = original;
  }
});

test('publicEvidenceReaderFromEnvironment returns undefined for empty gateway', () => {
  assert.equal(publicEvidenceReaderFromEnvironment({}), undefined);
  assert.equal(publicEvidenceReaderFromEnvironment({ IPFS_PUBLIC_GATEWAY_URL: '' }), undefined);
});
