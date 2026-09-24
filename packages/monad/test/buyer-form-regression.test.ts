/**
 * Regression guard: the buyer flow must not simulate a transaction.
 *
 * The behavioral guarantees live in `demo-truthfulness.test.ts`. This file guards
 * the source the browser actually loads, because the honest behavior is only
 * meaningful if the shipped component cannot reintroduce the fabrication it once
 * had: a fake 64-byte hash, a hard-coded block number, a locally assigned job ID,
 * a timer that "finalizes" a transaction nobody sent. The live flow may now
 * advance its lifecycle, but only from wallet, receipt, event, and dual-RPC reads.
 *
 * The tests are deliberately source-level and are labeled as such: they read
 * `apps/web/components/BuyerJobForm.tsx` as text.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SOURCE = resolve(process.cwd(), 'apps/web/components/BuyerJobForm.tsx');

let source: string;

test('the buyer form source is readable', async () => {
  source = await readFile(SOURCE, 'utf8');
  assert.ok(source.length > 0);
});

test('the buyer form does not fabricate a transaction hash', async () => {
  source = await readFile(SOURCE, 'utf8');
  // A literal 0x-prefixed run of hex is a stand-in for a hash nothing produced.
  const fakeHash = /'0x'\s*\+\s*['"][0-9a-fA-F]['"](\.repeat\(\d+\))?/;
  assert.ok(!fakeHash.test(source), 'must not construct a fake 64-byte hash');
  assert.ok(!/0x0{64}|0x1{64}|0xd{64}|0x[a-fA-F]\{64\}/.test(source), 'must not embed a fake hash');
});

test('the buyer form does not fabricate a block number or receipt', async () => {
  source = await readFile(SOURCE, 'utf8');
  assert.ok(
    /blockNumber:\s*outcome\.receipt\.blockNumber/.test(source),
    'a displayed block number must come from the observed receipt',
  );
  assert.ok(!/gasUsed\s*:/i.test(source));
  assert.ok(!/blockNumber:\s*\d+n/.test(source), 'no hard-coded block number');
});

test('the buyer form does not assign a local job ID', async () => {
  source = await readFile(SOURCE, 'utf8');
  assert.ok(!/setJobId\s*\(/.test(source), 'job IDs come from proposeJob on-chain');
  assert.ok(!/JOB\s*#\{/.test(source), 'no numbered job heading without an observed ID');
});

test('the buyer form does not simulate finality with a timer', async () => {
  source = await readFile(SOURCE, 'utf8');
  assert.ok(!/setTimeout/.test(source), 'a timer is not finality');
});

test('the buyer form drives the transaction lifecycle only after wallet and chain observations', async () => {
  source = await readFile(SOURCE, 'utf8');
  assert.ok(source.includes('executeBrowserTransaction(config, request'));
  assert.ok(source.includes('onSubmitted: tx.toSubmitted'));
  assert.ok(source.includes('decodeEventLog'));
  assert.ok(source.includes('matchedCanonicalJob'));
  assert.ok(source.includes("if (outcome.status === 'pending') return"));
  assert.ok(source.includes('tx.toFinalized({ blockNumber: outcome.receipt.blockNumber'));
});

test('the prepared request stays explicitly unbroadcast until the wallet action; funding uses observed job state', async () => {
  source = await readFile(SOURCE, 'utf8');
  // The label is imported, not spelled out in JSX, so a wording change lands in
  // the shared constant the behavioral test already pins.
  assert.ok(source.includes('PREPARED_NOT_BROADCAST_LABEL'));
  assert.ok(source.includes('observedJobId === null ? PREPARED_NOT_BROADCAST_LABEL'));
  assert.ok(source.includes('handleBroadcastProposal'));
  assert.ok(source.includes('disabled={!fundingAvailable}'));
  assert.ok(source.includes('canOfferFunding'));
  assert.ok(source.includes('observedJob?.status === 1'));
  assert.ok(source.includes('setObservedJobId(id)'));
  assert.ok(source.includes('const observation = await matchedCanonicalJob'));
});
