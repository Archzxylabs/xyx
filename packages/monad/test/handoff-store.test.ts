import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HandoffStore } from '../../../apps/web/lib/server/handoff-store';

test('encrypted handoff survives a real SQLite close and reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'xyx-handoff-'));
  const filename = path.join(directory, 'handoffs.sqlite');
  try {
    const first = new HandoffStore(filename);
    const created = first.create({ kind: 'terms', iv: 'a'.repeat(16), ciphertext: 'b'.repeat(64), expiresAt: 1_700_000_600 }, 1_700_000_000);
    first.close();

    const second = new HandoffStore(filename);
    const observed = second.read(created.id, 1_700_000_001);
    assert.deepEqual(observed, created);
    second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('expired handoff is deleted rather than returned', () => {
  const store = new HandoffStore(':memory:');
  try {
    const created = store.create({ kind: 'delivery', iv: 'c'.repeat(16), ciphertext: 'd'.repeat(64), expiresAt: 2_000 }, 1_000);
    assert.equal(store.read(created.id, 2_000), null);
    assert.equal(store.read(created.id, 2_001), null);
  } finally { store.close(); }
});

test('handoff store rejects plaintext-shaped and overlong inputs', () => {
  const store = new HandoffStore(':memory:');
  try {
    assert.throws(() => store.create({ kind: 'terms', iv: 'not base64url!', ciphertext: '{"private":"plaintext"}', expiresAt: 2_000 }, 1_000), /HANDOFF_IV_INVALID/);
    assert.throws(() => store.create({ kind: 'terms', iv: 'a'.repeat(16), ciphertext: 'b'.repeat(96 * 1024 + 1), expiresAt: 2_000 }, 1_000), /HANDOFF_CIPHERTEXT_INVALID/);
    assert.throws(() => store.create({ kind: 'terms', iv: 'a'.repeat(16), ciphertext: 'b'.repeat(64), expiresAt: 1_000 }, 1_000), /HANDOFF_EXPIRY_INVALID/);
  } finally { store.close(); }
});
