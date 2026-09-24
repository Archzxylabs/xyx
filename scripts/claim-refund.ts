import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { monadTestnet } from 'viem/chains';
import { deliveryProtocolAbi } from '../packages/monad/src/protocol';
import { MONAD_TESTNET_CHAIN_ID } from '../packages/monad/src/config';
import {
  checkGasLimitWithinTxCap,
  GasBufferError,
  MONAD_TX_GAS_LIMIT_CAP,
  resolveGasLimit,
} from '../packages/monad/src/deployment-readiness';
import {
  ObservationRpcError,
  resolveObservationRpcUrl,
} from '../packages/monad/src/observation-rpc';

/**
 * Canonical expiry refund for XYXDeliveryProtocol.
 *
 * The relayer broadcasts `claimExpiryRefund(jobId)` once the chain passes the
 * job's `expiresAt`. This path needs no attestor key and no IPFS read, so an
 * attestor outage cannot block a buyer refund.
 *
 * Requires a real deployment address; nothing here is simulated.
 *
 * HONESTY CONTRACT — what this script may and may not claim:
 *
 * - A locally signed transaction hash is a `signedCandidateHash`. It is NOT a
 *   `refundTx`. Until an RPC echoes that exact hash back and a successful
 *   finalized receipt is observed from TWO independent RPC endpoints, nothing
 *   is recorded as a refund.
 * - `refundTx` is written only after: broadcast returned the matching hash,
 *   the receipt status is success, the receipt is finalized, AND a second,
 *   distinct RPC independently observes that same receipt and the post-refund
 *   job state.
 * - An ambiguous submission failure records nothing as completed and returns a
 *   recovery-oriented error carrying only the non-secret candidate hash, so an
 *   operator can reconcile the candidate without this script re-sending.
 * - The relayer key comes from the environment only and is never logged, never
 *   written to disk, and never included in an error message.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const DEFAULT_RPC = 'https://testnet-rpc.monad.xyz';
const CONFIRMATIONS = 2;

/**
 * `JobStatus.Expired` — the single status `claimExpiryRefund` sets. XYXDeliveryProtocol.sol
 * enum: Proposed 0, Accepted 1, Funded 2, Submitted 3, Completed 4, Rejected 5,
 * Expired 6, Cancelled 7.
 */
const REFUNDED_JOB_STATUS = 6;

/**
 * Monad charges `gas_limit * price_per_gas`, not gas used, so an oversized
 * limit is a direct overpayment. The gas limit is therefore the actual estimate
 * plus a bounded buffer of at most {@link MAX_GAS_BUFFER_BPS} — never a blind
 * default such as 2,000,000.
 */
const DEFAULT_GAS_BUFFER_BPS = 500n; // 5%

export class ClaimRefundError extends Error {
  readonly code: string;
  readonly candidateHash?: Hex;
  constructor(code: string, message: string, candidateHash?: Hex) {
    super(message);
    this.name = 'ClaimRefundError';
    this.code = code;
    this.candidateHash = candidateHash;
  }
}

function protocolAddress(): Address {
  const value = process.env.XYX_PROTOCOL_ADDRESS;
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new ClaimRefundError('MISSING_XYX_PROTOCOL_ADDRESS', 'MISSING_XYX_PROTOCOL_ADDRESS');
  if (value.toLowerCase() === ZERO_ADDRESS) throw new ClaimRefundError('ZERO_XYX_PROTOCOL_ADDRESS', 'ZERO_XYX_PROTOCOL_ADDRESS');
  return value as Address;
}

function relayer() {
  const value = process.env.MONAD_RELAYER_PRIVATE_KEY;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ClaimRefundError('MISSING_MONAD_RELAYER_PRIVATE_KEY', 'MISSING_MONAD_RELAYER_PRIVATE_KEY');
  return privateKeyToAccount(value as Hex);
}

/**
 * The broadcast endpoint. Only ever the primary; the secondary is reserved for
 * independent observation and must never be used to submit.
 */
function broadcastRpc(): string {
  const value = process.env.XYX_RPC_URL;
  if (!value) return DEFAULT_RPC;
  if (!/^https?:\/\//.test(value)) throw new ClaimRefundError('INVALID_XYX_RPC_URL', 'INVALID_XYX_RPC_URL');
  // A URL with embedded credentials or a query token must never be used.
  if (/^[a-z]+:\/\/[^/]*@/.test(value) || value.includes('?')) {
    throw new ClaimRefundError('UNSAFE_XYX_RPC_URL', 'UNSAFE_XYX_RPC_URL');
  }
  return value;
}

/**
 * A second, DISTINCT Testnet RPC used only to independently observe the
 * receipt and post-refund job state. Required before any refund may be
 * recorded; without it, "the refund happened" would rest on a single endpoint
 * and could not be distinguished from an RPC that is replaying stale state.
 *
 * The endpoint comes from `XYX_SECONDARY_RPC_URL` alone — the variable
 * `.env.example` documents. There is no fallback to any other name, to the
 * primary RPC, or to a public default: a one-endpoint run is not a weaker
 * verification, it is no verification, so it fails closed instead.
 */
function observationRpc(primary: string): string {
  try {
    return resolveObservationRpcUrl(primary, process.env);
  } catch (error) {
    if (error instanceof ObservationRpcError) {
      throw new ClaimRefundError(error.code, error.code);
    }
    throw error;
  }
}

function publicClient(rpc: string): PublicClient {
  return createPublicClient({ chain: monadTestnet, transport: http(rpc, { timeout: 15_000 }) });
}

/**
 * Resolve the gas limit from an actual estimate of the contract call, plus a
 * bounded buffer, and enforce the operator ceiling.
 *
 * There is intentionally no blind fallback limit: a wallet that cannot estimate
 * has no basis for a number, and on Monad an arbitrary limit is real money.
 */
function resolveRefundGasLimit(estimate: bigint): bigint {
  const bufferRaw = process.env.MONAD_GAS_BUFFER_BPS;
  let bufferBps = DEFAULT_GAS_BUFFER_BPS;
  if (bufferRaw !== undefined && bufferRaw.trim() !== '') {
    if (!/^[0-9]+$/.test(bufferRaw.trim())) {
      throw new ClaimRefundError('GAS_BUFFER_INVALID', `GAS_BUFFER_INVALID: ${bufferRaw.trim()}`);
    }
    bufferBps = BigInt(bufferRaw.trim());
  }

  let decision;
  try {
    decision = resolveGasLimit(estimate, bufferBps);
  } catch (error) {
    if (error instanceof GasBufferError) {
      throw new ClaimRefundError(error.code, error.message);
    }
    throw error;
  }

  const capRaw = process.env.MONAD_MAX_TX_GAS;
  let operatorCap: bigint | null = null;
  if (capRaw !== undefined && capRaw.trim() !== '') {
    if (!/^[0-9]+$/.test(capRaw.trim())) {
      throw new ClaimRefundError('GAS_CAP_INVALID', `GAS_CAP_INVALID: ${capRaw.trim()}`);
    }
    operatorCap = BigInt(capRaw.trim());
    if (operatorCap <= 0n) throw new ClaimRefundError('GAS_CAP_INVALID', 'GAS_CAP_INVALID: cap must be positive');
    if (decision.requestedGasLimit > operatorCap) {
      throw new ClaimRefundError('GAS_LIMIT_EXCEEDS_OPERATOR_CAP', 'GAS_LIMIT_EXCEEDS_OPERATOR_CAP');
    }
  }

  const txCapViolation = checkGasLimitWithinTxCap(decision.requestedGasLimit);
  if (txCapViolation) {
    throw new ClaimRefundError(txCapViolation, `${txCapViolation}: requested ${decision.requestedGasLimit}, Monad transaction cap ${MONAD_TX_GAS_LIMIT_CAP}`);
  }

  return decision.requestedGasLimit;
}

/**
 * Persist a confirmed, finalized, dual-RPC-observed refund. Atomic: the temp
 * file is written with 0600 and renamed, so a reader never sees a partial run.
 *
 * This is the ONLY writer of `refundTx`. Nothing else in this file may call it.
 */
async function recordRefund(
  runName: string,
  jobId: string,
  refundTx: Hex,
  receipt: { blockNumber: string; blockHash: Hex; status: string; confirmations: string },
) {
  if (!/^[a-z0-9_-]{1,50}$/.test(runName)) throw new ClaimRefundError('INVALID_RUN_NAME', 'INVALID_RUN_NAME');
  const directory = resolve('demo-runs');
  const file = resolve(directory, `${runName}.json`);
  const run = JSON.parse(await readFile(file, 'utf8')) as {
    jobId?: string;
    refundTx?: Hex;
  };
  if (run.jobId !== jobId) throw new ClaimRefundError('RUN_JOB_ID_MISMATCH', 'RUN_JOB_ID_MISMATCH');
  if (run.refundTx && run.refundTx.toLowerCase() !== refundTx.toLowerCase()) {
    throw new ClaimRefundError('REFUND_RECONCILIATION_REQUIRED', 'REFUND_RECONCILIATION_REQUIRED');
  }
  await mkdir(directory, { recursive: true });
  const temporary = file + '.tmp';
  await writeFile(
    temporary,
    JSON.stringify(
      {
        ...run,
        refundTx,
        refundReceipt: {
          blockNumber: receipt.blockNumber,
          blockHash: receipt.blockHash,
          status: receipt.status,
          confirmations: receipt.confirmations,
        },
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  await rename(temporary, file);
}

/**
 * A successful, finalized receipt from an endpoint OTHER than the broadcast
 * endpoint. This is what makes the recorded refund independent evidence rather
 * than the same node agreeing with itself.
 */
async function observeFromSecondary(
  observer: PublicClient,
  protocol: Address,
  jobId: string,
  hash: Hex,
): Promise<{ receipt: TransactionReceipt; refundedStatus: number }> {
  const receipt = await observer.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== 'success') {
    throw new ClaimRefundError('REFUND_RECEIPT_NOT_SUCCESS', 'REFUND_RECEIPT_NOT_SUCCESS');
  }

  const job = await observer.readContract({
    address: protocol,
    abi: deliveryProtocolAbi,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  }) as { status: number };

  return { receipt, refundedStatus: Number(job.status) };
}

async function main() {
  const [jobId, runName] = process.argv.slice(2);
  if (!jobId || !/^[1-9][0-9]*$/.test(jobId)) throw new ClaimRefundError('USAGE', 'USAGE: claim-refund <job-id> [run-name]');
  if (runName !== undefined && !/^[a-z0-9_-]{1,50}$/.test(runName)) {
    throw new ClaimRefundError('INVALID_RUN_NAME', 'INVALID_RUN_NAME');
  }

  const protocol = protocolAddress();
  const rpc = broadcastRpc();
  const observationUrl = observationRpc(rpc);
  const client = publicClient(rpc);
  const observer = publicClient(observationUrl);

  // Both endpoints must independently agree on the chain before anything else.
  for (const [label, endpoint] of [['primary', client], ['secondary', observer]] as const) {
    const chainId = await endpoint.getChainId();
    if (chainId !== MONAD_TESTNET_CHAIN_ID) {
      throw new ClaimRefundError('WRONG_CHAIN', `WRONG_CHAIN: ${label} reports ${chainId}`);
    }
  }

  const code = await client.getCode({ address: protocol });
  if (!code || code === '0x') throw new ClaimRefundError('PROTOCOL_CODE_MISSING', 'PROTOCOL_CODE_MISSING');

  // JobStatus: 0 Proposed, 1 Accepted, 2 Funded, 3 Submitted, 4 Completed,
  // 5 Rejected, 6 Expired, 7 Cancelled. Only Funded/Submitted can refund.
  const job = await client.readContract({
    address: protocol,
    abi: deliveryProtocolAbi,
    functionName: 'getJob',
    args: [BigInt(jobId)],
  }) as { status: number; expiresAt: bigint };
  if (![2, 3].includes(job.status)) throw new ClaimRefundError('REFUND_NOT_READY', `REFUND_NOT_READY: status ${job.status}`);
  const head = await client.getBlock();
  if (head.timestamp < job.expiresAt) throw new ClaimRefundError('NOT_EXPIRED', `NOT_EXPIRED: expiresAt ${job.expiresAt}`);

  const account = relayer();
  const wallet = createWalletClient({ account, chain: monadTestnet, transport: http(rpc, { timeout: 15_000 }) });
  const data = encodeFunctionData({ abi: deliveryProtocolAbi, functionName: 'claimExpiryRefund', args: [BigInt(jobId)] });

  // Estimate the actual contract call. An unbufferable estimate is a hard stop,
  // not a cue to fall back to a default limit.
  let estimatedGas: bigint;
  try {
    estimatedGas = await client.estimateGas({ account: account.address, to: protocol, data });
  } catch {
    throw new ClaimRefundError('GAS_ESTIMATE_MISSING', 'GAS_ESTIMATE_MISSING: cannot estimate claimExpiryRefund');
  }
  if (estimatedGas <= 0n) throw new ClaimRefundError('GAS_ESTIMATE_MISSING', 'GAS_ESTIMATE_MISSING: estimate was zero');

  const gas = resolveRefundGasLimit(estimatedGas);

  const request = await wallet.prepareTransactionRequest({
    to: protocol,
    data,
    account,
    chain: monadTestnet,
    gas,
  });

  const serialized = await wallet.signTransaction(request);
  const signedCandidateHash = keccak256(serialized);

  // NOTHING has been recorded yet. The signed hash is only a candidate.
  console.log(JSON.stringify({
    jobId,
    signedCandidateHash,
    runName,
    broadcast: 'pending',
    refundTx: null,
    note: 'signedCandidateHash is a local signature hash. It is not a refundTx until an RPC echoes it back and a finalized receipt is observed.',
  }, null, 2));

  let broadcastHash: Hex;
  try {
    broadcastHash = await client.sendRawTransaction({ serializedTransaction: serialized });
  } catch (error) {
    // Ambiguous submission failure: the transaction may or may not have been
    // accepted. Write nothing as completed, and hand the operator the candidate
    // hash (never the key) so the candidate can be reconciled by hand.
    throw new ClaimRefundError(
      'REFUND_SUBMISSION_AMBIGUOUS',
      `REFUND_SUBMISSION_AMBIGUOUS: ${error instanceof Error ? error.message : 'unknown error'}. ` +
        `Reconcile candidate ${signedCandidateHash} before sending anything else.`,
      signedCandidateHash,
    );
  }

  if (broadcastHash.toLowerCase() !== signedCandidateHash.toLowerCase()) {
    // The node accepted something other than what we signed. Never record it.
    throw new ClaimRefundError(
      'REFUND_HASH_MISMATCH',
      `REFUND_HASH_MISMATCH: RPC returned ${broadcastHash}, locally signed candidate is ${signedCandidateHash}`,
      signedCandidateHash,
    );
  }

  console.log(JSON.stringify({ jobId, signedCandidateHash, refundTx: broadcastHash, broadcast: 'submitted' }, null, 2));

  // Wait for the broadcast endpoint's own view of a successful receipt.
  const receipt = await client.waitForTransactionReceipt({ hash: broadcastHash, confirmations: CONFIRMATIONS });
  if (receipt.status !== 'success') {
    throw new ClaimRefundError(`REFUND_REVERTED_${receipt.transactionHash}`, `REFUND_REVERTED_${receipt.transactionHash}`, broadcastHash);
  }

  // Then require a SECOND, distinct RPC to independently observe the same
  // receipt and the post-refund job state. Without this, the recorded refund
  // would rest on a single endpoint's word.
  const observed = await observeFromSecondary(observer, protocol, jobId, broadcastHash);
  if (observed.receipt.blockHash !== receipt.blockHash) {
    throw new ClaimRefundError('REFUND_BLOCK_HASH_DISAGREEMENT', 'REFUND_BLOCK_HASH_DISAGREEMENT', broadcastHash);
  }

  // `claimExpiryRefund` moves the job to JobStatus.Expired (6) and nothing
  // else. Any other post-state means the transaction we recorded did not do
  // what we think it did, so nothing may be recorded as a refund.
  if (observed.refundedStatus !== REFUNDED_JOB_STATUS) {
    throw new ClaimRefundError(
      'REFUND_POST_STATE_UNCONFIRMED',
      `REFUND_POST_STATE_UNCONFIRMED: secondary reports job status ${observed.refundedStatus}, expected ${REFUNDED_JOB_STATUS}`,
      broadcastHash,
    );
  }

  // Only now, with broadcast hash match + successful finalized receipt +
  // independent secondary observation, is a refundTx recorded.
  if (runName) {
    await recordRefund(runName, jobId, broadcastHash, {
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
      status: receipt.status,
      confirmations: String(CONFIRMATIONS),
    });
  }

  console.log(JSON.stringify({
    jobId,
    refundTx: broadcastHash,
    signedCandidateHash,
    broadcast: 'confirmed',
    observedBySecondary: observationUrl,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    receiptStatus: receipt.status,
    confirmations: CONFIRMATIONS,
    postRefundJobStatus: observed.refundedStatus,
    recorded: Boolean(runName),
  }, null, 2));
}

main().catch(error => {
  if (error instanceof ClaimRefundError) {
    console.error(JSON.stringify({ code: error.code, candidateHash: error.candidateHash ?? null }, null, 2));
  } else {
    console.error(error instanceof Error ? error.message : 'CLAIM_REFUND_FAILED');
  }
  process.exitCode = 1;
});
