/** Pure cryptographic/data validation; no mocked RPC, wallet, or chain evidence. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryCommitment, type PrivateDeliveryInput, type PrivateTermsInput } from '../src/delivery';
import { makePrivateTermsBundle, parsePrivateTermsBundle, parsePrivateDeliveryBundle,
  taskTransferFromTerms } from '../../../apps/web/lib/private-terms-bundle';

const terms: PrivateTermsInput = {
  schema: 'xyx.private-terms', chainId: 10143,
  protocol: '0x1111111111111111111111111111111111111111',
  paymentToken: '0x2222222222222222222222222222222222222222',
  buyer: '0x3333333333333333333333333333333333333333',
  provider: '0x4444444444444444444444444444444444444444',
  attestor: '0x5555555555555555555555555555555555555555',
  budgetAtomic: '1000000', expiresAt: 1_900_000_000,
  task: { recipient: '0x6666666666666666666666666666666666666666', amountAtomic: '250000', instructions: 'Transfer exactly the agreed amount' },
  acceptancePolicy: { rule: 'Transfer receipt must be finalized and match the terms' },
};
const salt = `0x${'ab'.repeat(32)}` as const;

test('private terms bundle rehashes the exact data and keeps real receipt references separate', () => {
  const bundle = makePrivateTermsBundle(terms, salt, { jobId: 7n, fundingTx: `0x${'ef'.repeat(32)}` });
  const parsed = parsePrivateTermsBundle(JSON.stringify(bundle));
  assert.equal(parsed.commitment, bundle.commitment);
  assert.equal(parsed.jobId, '7');
  assert.equal(parsed.fundingTx, bundle.fundingTx);
  assert.equal(taskTransferFromTerms(parsed.terms).amountAtomic, 250000n);
  assert.throws(() => parsePrivateTermsBundle(JSON.stringify({ ...bundle, terms: { ...terms, task: { ...terms.task, amountAtomic: '250001' } } })),
    /COMMITMENT_MISMATCH/);
  assert.throws(() => parsePrivateTermsBundle(JSON.stringify({ ...bundle, fundingTx: undefined })), /INVALID/);
});

test('private delivery bundle ties transfer hash, payload, salt, and commitment', () => {
  const transferTx = `0x${'cd'.repeat(32)}` as const;
  const delivery: PrivateDeliveryInput = { schema: 'xyx.private-delivery', kind: 'erc20-transfer',
    content: { transferTx, recipient: terms.task.recipient, amountAtomic: terms.task.amountAtomic, response: 'Completed' } };
  const commitment = createDeliveryCommitment(7n, delivery, salt).commitment;
  const bundle = { schema: 'xyx.private-delivery-bundle.v1', jobId: '7', delivery, salt, commitment,
    transferTx, submissionTx: `0x${'dd'.repeat(32)}` };
  assert.equal(parsePrivateDeliveryBundle(JSON.stringify(bundle)).commitment, commitment);
  assert.throws(() => parsePrivateDeliveryBundle(JSON.stringify({ ...bundle, transferTx: `0x${'ee'.repeat(32)}` })),
    /DELIVERY_TRANSFER_HASH_MISMATCH/);
  assert.throws(() => parsePrivateDeliveryBundle(JSON.stringify({ ...bundle, delivery: { ...delivery, kind: 'changed' } })),
    /COMMITMENT_MISMATCH/);
});

test('private bundle task transfer rejects missing or invalid recipient and amount', () => {
  assert.throws(() => taskTransferFromTerms({ ...terms, task: { recipient: terms.task.recipient, amountAtomic: '0' } }),
    /TASK_AMOUNT_REQUIRED/);
  assert.throws(() => taskTransferFromTerms({ ...terms, task: { recipient: '0x0000000000000000000000000000000000000000', amountAtomic: '1' } }),
    /TASK_RECIPIENT_REQUIRED/);
});
