/**
 * Canonical provider runner for XYXDeliveryProtocol (Monad Testnet).
 *
 * The runner drives one funded job from "the provider holds the private input"
 * to "a finalized DeliverySubmitted receipt is observed", in five stages, with
 * one hard invariant across all of them: every claim it makes is a fact that was
 * read from a finalized, two-RPC-agreed block, and every gap in that evidence is
 * reported as a gap rather than filled in.
 *
 * The five stages, in order, each of which must complete before the next opens:
 *
 *   1. `SELECTED`           — the job exists and the runner's signer is its provider.
 *   2. `PREPARED_NO_TRANSFER` — the private input was decrypted, validated against
 *                             the on-chain job, and executed. Preparation never
 *                             executes the task transfer, so stage 2 deliberately
 *                             completes without one: the final commitment cannot be
 *                             computed until the transfer is settled, because the
 *                             transfer hash is part of the committed payload.
 *   3. `TRANSFERRED`        — the required ERC-20 task transfer is settled, its
 *                             finalized two-RPC receipt was decoded and matched to
 *                             the terms, and the delivery commitment was recomputed
 *                             over the now-complete private payload.
 *   4. `SUBMITTED`          — the canonical `submitDelivery` request was broadcast
 *                             and a hash came back. This stage is explicitly NOT
 *                             evidence of success: a hash is not a receipt.
 *   5. `FINALIZED`          — two independent RPCs agree on the finalized receipt,
 *                             which proves the protocol emitted `DeliverySubmitted`
 *                             for this job with exactly this delivery commitment,
 *                             and the job reads back `Submitted` at that block.
 *
 * Two properties are structural, not incidental:
 *
 *   - The runner NEVER performs the task transfer itself. An already-performed
 *     transfer reaches it as an `observed` hash it must verify, or as an
 *     `execute` hook the integrator supplies. If neither exists the run fails at
 *     stage 3 rather than quietly submitting a delivery that never did the work.
 *     The runner's single on-chain write is `submitDelivery`, built by the
 *     canonical builder in `delivery-chain.ts`; this module never constructs
 *     calldata by hand.
 *
 *   - There is no success-shaped fallback anywhere. An ambiguous send (no hash,
 *     signer refusal, user cancellation) never advances to `FINALIZED`; it ends
 *     as `SUBMITTED_AMBIGUOUS` or `FAILED` with the honest reason, so a caller
 *     cannot read "no error" as "delivered". The runner has no simulated-send
 *     mode and no default signer: a signer must be injected by the integrator.
 *
 * Rehearsal and reuse: `prepare()` runs stages 1–3 without touching a signer at
 * all, so an integrator can compute the exact request a wallet will be asked to
 * sign and diff it against the canonical one. `settle()` runs stage 5 and is the
 * reconciliation entry point for a broadcast that was interrupted, so a crashed
 * runner never has to resend.
 *
 * @module @xyx/monad/provider-runner
 */

import type { Address, Hex } from 'viem';
import { decodeEventLog } from 'viem';

import {
  assertMonadTestnet,
  finalizedBlock,
  matchedCanonicalJob,
  matchedFinalizedReceipt,
  readCanonicalJob,
  sameCanonicalJob,
  type CanonicalChainReader,
  type CanonicalFinalizedBlock,
} from '../canonical-chain';
import {
  createDeliveryCommitment,
  privateDeliverySchema,
  type PrivateDeliveryInput,
} from '../delivery';
import {
  buildSubmitRequest,
  MONAD_TESTNET_CHAIN_ID,
  type ContractAddresses,
  type ContractRequest,
} from '../delivery-chain';
import { deliveryProtocolAbi, type JobData } from '../protocol';
import { sameAddress, sameHex, type TransferLog } from '../chain-primitives';
import { validateSalt } from '../commitments';
import { CANONICAL_JOB_STATUS } from '../settlement';

import type {
  PrivateDeliveryMaterial,
  PrivateInputProvider,
  ProviderJobView,
  ProviderSigner,
  TaskExecutionResult,
  TaskExecutor,
  TaskTransferRequirement,
} from './adapters';

// ---------------------------------------------------------------------------
// Public vocabulary
// ---------------------------------------------------------------------------

/**
 * ERC-20 `Transfer`, used to read which token emitted each log.
 *
 * Declared locally rather than imported so the decoder sees the same shape the
 * shared `tokenTransfers` primitive decodes, without depending on an export
 * this module does not own.
 */
const TRANSFER_EVENT_ABI = [
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** How far a run actually got, grounded in observed evidence only. */
export type RunStatus =
  /** A real job was read and the provider matches. */
  | 'SELECTED'
  /**
   * Stage 2 evidence is complete except the task transfer, which has NOT been
   * verified yet. The delivery commitment is deliberately absent at this status:
   * it binds a payload that does not exist until the transfer is settled.
   */
  | 'PREPARED_NO_TRANSFER'
  /** Stage 3: the transfer is settled and the final commitment is computed. */
  | 'TRANSFERRED'
  /** A broadcast happened and a hash came back. Nothing is proven about it yet. */
  | 'SUBMITTED'
  /** Stage 5: two RPCs agree on a finalized receipt containing DeliverySubmitted. */
  | 'FINALIZED'
  /** A send ended without a hash, so the outcome is genuinely unknown. */
  | 'SUBMITTED_AMBIGUOUS'
  /** The run cannot continue: configuration, evidence, or a stage failed. */
  | 'FAILED';

/** One stage the runner completed, with the honest reason it recorded. */
export interface RunStep {
  readonly status: RunStatus;
  readonly detail: string;
}

/** The failure taxonomy an integrator must surface verbatim. */
export type RunFailureCode =
  | 'CHAIN_GUARD_FAILED'
  | 'SIGNER_REQUIRED'
  | 'SIGNER_NOT_PROVIDER'
  | 'JOB_READ_FAILED'
  | 'JOB_NOT_FUNDED'
  | 'JOB_ALREADY_SUBMITTED'
  | 'PRIVATE_INPUT_REQUIRED'
  | 'PRIVATE_INPUT_INVALID'
  | 'EXECUTION_FAILED'
  | 'TRANSFER_PLAN_REQUIRED'
  | 'TRANSFER_NOT_OBSERVED'
  | 'TRANSFER_TOKEN_MISMATCH'
  | 'TRANSFER_NOT_FINALIZED'
  | 'TRANSFER_RPC_CONFLICT'
  | 'TRANSFER_MISMATCH'
  | 'COMMITMENT_INVALID'
  | 'REQUEST_INVALID'
  | 'SEND_FAILED'
  | 'RECEIPT_NOT_FINALIZED'
  | 'RECEIPT_RPC_CONFLICT'
  | 'SUBMISSION_REVERTED'
  | 'RECEIPT_MISSING_EVENT'
  | 'RECEIPT_EVENT_AMBIGUOUS'
  | 'RECEIPT_COMMITMENT_MISMATCH'
  | 'SUBMISSION_NOT_OBSERVED';

export class RunnerError extends Error {
  readonly code: RunFailureCode;
  constructor(code: RunFailureCode, message: string) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Evidence records — the only things a caller may treat as proof
// ---------------------------------------------------------------------------

/** A finalized, two-RPC-agreed ERC-20 transfer that satisfies the terms. */
export interface ObservedTransfer {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  readonly token: Address;
  readonly sender: Address;
  readonly recipient: Address;
  readonly amountAtomic: bigint;
}

/** A finalized, two-RPC-agreed receipt for the `submitDelivery` broadcast. */
export interface ObservedSubmission {
  readonly transactionHash: Hex;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly timestamp: bigint;
  /** The delivery commitment the canonical event carried, decoded from the receipt. */
  readonly deliveryCommitment: Hex;
  /** The finalized block both RPCs agreed on when the receipt was verified. */
  readonly observation: CanonicalFinalizedBlock;
}

/** Everything the runner observed. Safe to log: no secrets, no guesses. */
export interface RunEvidence {
  readonly status: RunStatus;
  readonly jobId: bigint;
  readonly job?: JobData;
  readonly observation?: CanonicalFinalizedBlock;
  readonly transfer?: ObservedTransfer;
  readonly submission?: ObservedSubmission;
  /** The delivery commitment that was (or would be) submitted. */
  readonly deliveryCommitment?: Hex;
  /** The exact canonical contract request, for wallet display and diffing. */
  readonly request?: ContractRequest;
  readonly steps: readonly RunStep[];
  readonly failure?: { readonly code: RunFailureCode; readonly message: string };
}

/**
 * How the required task transfer is obtained.
 *
 * The runner deliberately never sends this transfer itself. Either the
 * integrator already performed it and hands the runner an observed hash to
 * verify (`observedTransactionHash`), or the integrator supplies the execution
 * capability to perform it (`execute`). Neither may be faked: with no hash and
 * no execute hook the run fails at stage 3 instead of submitting a delivery
 * that never did the work.
 *
 * An integrator that modelled the terms together with their proof may instead
 * put the observed hash on the requirement itself
 * (`requirement.observedTransactionHash`). That spelling is a deprecated alias
 * for the plan-level field; when both are set they must name the same hash.
 */
export interface TaskTransferPlan {
  readonly requirement: TaskTransferRequirement;
  /**
   * A transfer transaction the integrator already broadcast, for the runner to
   * verify against canonical two-RPC chain state rather than to perform.
   */
  readonly observedTransactionHash?: Hex;
  /** Perform the transfer outside the runner and return the broadcast hash. */
  readonly execute?: () => Promise<Hex>;
}

/** Stage 3's output: the commitment bound to the completed private payload. */
export interface PreparedDelivery {
  readonly delivery: PrivateDeliveryInput;
  readonly commitment: Hex;
  readonly transfer: ObservedTransfer;
  readonly request: ContractRequest;
  readonly observation: CanonicalFinalizedBlock;
  /** The job as it read at selection, so a later `settle()` can report it. */
  readonly job: JobData;
}

export interface ProviderRunnerConfig {
  /** The job to run. Must be positive. */
  readonly jobId: bigint;
  readonly addresses: ContractAddresses;
  /** Primary Monad Testnet reader. */
  readonly primary: CanonicalChainReader;
  /** Independent second Monad Testnet reader, used for every evidence claim. */
  readonly secondary: CanonicalChainReader;
  /** Source of the private task input the provider holds. */
  readonly privateInput: PrivateInputProvider;
  /** Performs the real work whose result the delivery commitment binds. */
  readonly executor: TaskExecutor;
  /**
   * The protocol's payment token. Required and never optional: the runner checks
   * the settled task transfer against it, and an unchecked transfer would be
   * unverifiable evidence.
   */
  readonly paymentToken: Address;
  /** How the required task transfer is obtained. Always required. */
  readonly transfer: TaskTransferPlan;
  /**
   * The signer that broadcasts `submitDelivery`. Only needed by `run()`:
   * `prepare()` builds the request without touching a signer, so a rehearsal
   * needs no wallet at all.
   */
  readonly signer?: ProviderSigner;
  readonly chainId?: number;
}

export interface RunOutcome {
  readonly evidence: RunEvidence;
  /** Present once stage 3 completed; the handle `settle()` reconciles. */
  readonly prepared?: PreparedDelivery;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const ZERO_WORD = /^0x0{64}$/i;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export class ProviderRunner {
  private readonly steps: RunStep[] = [];

  constructor(private readonly config: ProviderRunnerConfig) {
    if (typeof config.jobId !== 'bigint' || config.jobId <= 0n) {
      throw new RunnerError('JOB_READ_FAILED', 'jobId must be a positive bigint');
    }
    if (!config.addresses || typeof config.addresses.protocol !== 'string') {
      throw new RunnerError('JOB_READ_FAILED', 'contract addresses are required');
    }
    if (!config.primary || !config.secondary) {
      throw new RunnerError('CHAIN_GUARD_FAILED', 'two independent RPC readers are required');
    }
    if (!config.transfer || !config.transfer.requirement) {
      throw new RunnerError('TRANSFER_PLAN_REQUIRED', 'a task transfer plan is required before any stage runs');
    }
    validateTransferRequirement(config.transfer.requirement);
    validateObservedTransferHash(config.transfer.observedTransactionHash);
    if (typeof config.paymentToken !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(config.paymentToken)) {
      throw new RunnerError('TRANSFER_MISMATCH', 'the protocol payment token must be an address');
    }
    if (this.config.chainId !== undefined && this.config.chainId !== MONAD_TESTNET_CHAIN_ID) {
      throw new RunnerError('CHAIN_GUARD_FAILED', `only chain ID ${MONAD_TESTNET_CHAIN_ID} is supported`);
    }
  }

  // -- public entry points --------------------------------------------------

  /**
   * Stages 1–3: read the job, decrypt and validate the private input, execute the
   * real work, settle and verify the task transfer, and compute the canonical
   * delivery commitment and `submitDelivery` request.
   *
   * Performs no signing and no protocol write, so an integrator can inspect the
   * exact request a wallet will be asked to approve.
   */
  async prepare(): Promise<RunOutcome> {
    const { job, observation } = await this.selectJob();
    const material = await this.readPrivateInput(job);
    const executed = await this.executeTask(job, material);
    const transfer = await this.settleTransfer(job);
    const prepared = await this.bindDelivery(job, material, executed, transfer, observation);
    this.record('TRANSFERRED', 'task transfer settled and delivery commitment computed');
    return {
      evidence: {
        status: 'TRANSFERRED',
        jobId: this.config.jobId,
        job,
        observation,
        transfer,
        deliveryCommitment: prepared.commitment,
        request: prepared.request,
        steps: [...this.steps],
      },
      prepared,
    };
  }

  /**
   * Stage 5 only: reconcile a broadcast whose hash is already known.
   *
   * This is the recovery path for an interrupted run — a crashed or closed
   * client that already sent `submitDelivery` calls this instead of `run()`, so it
   * never broadcasts a second transaction for a job that was already submitted.
   */
  async settle(prepared: PreparedDelivery, transactionHash: Hex): Promise<RunOutcome> {
    if (!prepared || typeof prepared.commitment !== 'string' || !HASH_RE.test(prepared.commitment)) {
      throw new RunnerError('COMMITMENT_INVALID', 'prepared delivery with a valid commitment is required');
    }
    if (!prepared.job) {
      throw new RunnerError('JOB_READ_FAILED', 'the prepared delivery must carry the job that was selected');
    }
    if (typeof transactionHash !== 'string' || !HASH_RE.test(transactionHash)) {
      throw new RunnerError('SUBMISSION_NOT_OBSERVED', 'a 32-byte transaction hash is required to settle');
    }
    // Re-read the job at the finalized head before verifying: this run may be
    // resuming hours later, and an integrator must not be able to settle a hash
    // against a job that has since been cancelled or resolved.
    //
    // Read from BOTH readers. settle() is the recovery path most likely to be
    // run much later against a different RPC endpoint, so one reader's word is
    // not enough to declare the job Submitted.
    let observedJob: JobData;
    try {
      observedJob = await matchedCanonicalJobHere(
        this.config.primary,
        this.config.secondary,
        this.config.addresses.protocol,
        this.config.jobId
      );
    } catch (error) {
      throw new RunnerError(
        messageOf(error).includes('RPC_STATE_MISMATCH') ? 'RECEIPT_RPC_CONFLICT' : 'JOB_READ_FAILED',
        messageOf(error)
      );
    }
    if (observedJob.status !== CANONICAL_JOB_STATUS.Submitted) {
      throw new RunnerError(
        'JOB_ALREADY_SUBMITTED',
        `job ${this.config.jobId} is ${jobStatusName(observedJob.status)}; settle() expects a submission that has already landed`
      );
    }
    if (observedJob.deliveryCommitment.toLowerCase() !== prepared.commitment.toLowerCase()) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        `job carries deliveryCommitment ${observedJob.deliveryCommitment}, not the prepared ${prepared.commitment}`
      );
    }
    const submission = await this.verifySubmission(
      observedJob,
      prepared.request,
      prepared.commitment,
      transactionHash
    );
    return {
      evidence: {
        status: 'FINALIZED',
        jobId: this.config.jobId,
        job: observedJob,
        observation: submission.observation,
        transfer: prepared.transfer,
        submission,
        deliveryCommitment: prepared.commitment,
        request: prepared.request,
        steps: [...this.steps],
      },
      prepared,
    };
  }

  /**
   * Stages 1–5: prepare, broadcast the canonical request through the injected
   * signer, and verify the finalized receipt. Requires a signer.
   */
  async run(): Promise<RunOutcome> {
    const signer = this.requireSigner();
    const { evidence, prepared } = await this.prepare();
    if (evidence.status === 'FAILED' || !prepared) return { evidence };

    this.record('SUBMITTED', 'broadcasting the canonical submitDelivery request');
    const sendOutcome = await signer.sendTransaction(prepared.request);

    if (sendOutcome.kind === 'submitted') {
      this.record('SUBMITTED', `broadcast returned hash ${sendOutcome.transactionHash}; nothing is yet proven`);
      const verified = await this.verifySubmission(
        prepared.job,
        prepared.request,
        prepared.commitment,
        sendOutcome.transactionHash
      );
      return {
        evidence: {
          status: 'FINALIZED',
          jobId: this.config.jobId,
          job: evidence.job,
          observation: verified.observation,
          transfer: prepared.transfer,
          submission: verified,
          deliveryCommitment: prepared.commitment,
          request: prepared.request,
          steps: [...this.steps],
        },
        prepared,
      };
    }

    if (sendOutcome.kind === 'ambiguous') {
      // No hash came back. The transaction may or may not have been broadcast,
      // so this must NOT be reported as success and must NOT be retried blindly.
      this.record('SUBMITTED_AMBIGUOUS', 'no transaction hash returned; the outcome is unknown');
      return {
        evidence: {
          status: 'SUBMITTED_AMBIGUOUS',
          jobId: this.config.jobId,
          job: evidence.job,
          observation: evidence.observation,
          transfer: prepared.transfer,
          deliveryCommitment: prepared.commitment,
          request: prepared.request,
          steps: [...this.steps],
          failure: {
            code: 'SUBMISSION_NOT_OBSERVED',
            message:
              'the signer returned no transaction hash, so it is unknown whether submitDelivery was broadcast. ' +
              'Reconcile with settle() using the real hash; do not resend.',
          },
        },
        prepared,
      };
    }

    if (sendOutcome.kind === 'cancelled') {
      this.record('FAILED', 'the signer cancelled before signing');
      return {
        evidence: {
          status: 'FAILED',
          jobId: this.config.jobId,
          job: evidence.job,
          observation: evidence.observation,
          transfer: prepared.transfer,
          deliveryCommitment: prepared.commitment,
          request: prepared.request,
          steps: [...this.steps],
          failure: { code: 'SEND_FAILED', message: 'the send was cancelled before signing' },
        },
        prepared,
      };
    }

    this.record('FAILED', `the signer refused: ${sendOutcome.reason}`);
    return {
      evidence: {
        status: 'FAILED',
        jobId: this.config.jobId,
        job: evidence.job,
        observation: evidence.observation,
        transfer: prepared.transfer,
        deliveryCommitment: prepared.commitment,
        request: prepared.request,
        steps: [...this.steps],
        failure: { code: 'SEND_FAILED', message: sendOutcome.reason },
      },
      prepared,
    };
  }

  // -- stage 1: select the job ---------------------------------------------

  private async selectJob(): Promise<{
    job: JobData;
    observation: CanonicalFinalizedBlock;
  }> {
    let observation: CanonicalFinalizedBlock;
    let job: JobData;
    try {
      ({ job, observation } = await matchedCanonicalJob(
        this.config.primary,
        this.config.secondary,
        this.config.addresses.protocol,
        this.config.jobId
      ));
    } catch (error) {
      throw new RunnerError('JOB_READ_FAILED', messageOf(error));
    }

    if (this.config.signer && !sameAddress(this.config.signer.address, job.provider)) {
      throw new RunnerError(
        'SIGNER_NOT_PROVIDER',
        `signer ${this.config.signer.address} is not the job provider ${job.provider}`
      );
    }
    if (job.status === CANONICAL_JOB_STATUS.Proposed || job.status === CANONICAL_JOB_STATUS.Accepted) {
      throw new RunnerError(
        'JOB_NOT_FUNDED',
        `job is ${jobStatusName(job.status)}; a provider runner can only submit a delivery for a funded job`
      );
    }
    if (job.status === CANONICAL_JOB_STATUS.Submitted ||
        job.status === CANONICAL_JOB_STATUS.Completed ||
        job.status === CANONICAL_JOB_STATUS.Rejected ||
        job.status === CANONICAL_JOB_STATUS.Expired ||
        job.status === CANONICAL_JOB_STATUS.Cancelled) {
      throw new RunnerError(
        'JOB_ALREADY_SUBMITTED',
        `job is ${jobStatusName(job.status)} with deliveryCommitment ${job.deliveryCommitment}; submitting again would revert`
      );
    }
    if (!ZERO_WORD.test(job.deliveryCommitment)) {
      throw new RunnerError(
        'JOB_ALREADY_SUBMITTED',
        `job already carries a non-zero deliveryCommitment ${job.deliveryCommitment}`
      );
    }

    this.record('SELECTED', `job ${this.config.jobId} is funded with provider ${job.provider}`);
    return { job, observation };
  }

  // -- stage 2: private input and real work ---------------------------------

  private async readPrivateInput(job: JobData): Promise<PrivateDeliveryMaterial> {
    if (!this.config.privateInput || typeof this.config.privateInput.provide !== 'function') {
      throw new RunnerError('PRIVATE_INPUT_REQUIRED', 'a private input provider is required');
    }
    const material = await this.config.privateInput.provide(toJobView(this.config.jobId, job));
    if (!material || typeof material !== 'object') {
      throw new RunnerError('PRIVATE_INPUT_INVALID', 'the private input provider returned no material');
    }
    return material;
  }

  private async executeTask(
    job: JobData,
    material: PrivateDeliveryMaterial
  ): Promise<Record<string, unknown>> {
    if (!this.config.executor || typeof this.config.executor.execute !== 'function') {
      throw new RunnerError('EXECUTION_FAILED', 'a task executor is required');
    }
    const result: TaskExecutionResult = await this.config.executor.execute(
      toJobView(this.config.jobId, job),
      material
    );
    if (!result || result.ok !== true) {
      throw new RunnerError(
        'EXECUTION_FAILED',
        result && result.ok === false ? result.reason : 'the task executor returned no result'
      );
    }
    const delivery = result.delivery;
    if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
      throw new RunnerError('EXECUTION_FAILED', 'the task executor must return a structured object');
    }
    this.record(
      'PREPARED_NO_TRANSFER',
      'task executed; the delivery commitment is not computed until the task transfer is settled'
    );
    return delivery;
  }

  // -- stage 3: task transfer and commitment binding ------------------------

  private async settleTransfer(job: JobData): Promise<ObservedTransfer> {
    const requirement = this.config.transfer.requirement;
    const plan = this.config.transfer;

    // The observed hash may sit on the plan or, for integrators that modelled
    // the terms and their proof as one object, on the requirement. Both spellings
    // are accepted, and when an integrator supplies both they must agree: a
    // disagreement is two claims about the same transfer, so the run cannot
    // decide which one the chain is evidence for and must fail closed.
    if (
      plan.observedTransactionHash !== undefined &&
      requirement.observedTransactionHash !== undefined &&
      !sameHex(plan.observedTransactionHash, requirement.observedTransactionHash)
    ) {
      throw new RunnerError(
        'TRANSFER_NOT_OBSERVED',
        'the task transfer hash was given twice with different values'
      );
    }

    let hash: Hex | undefined = plan.observedTransactionHash ?? requirement.observedTransactionHash;
    if (hash === undefined) {
      if (!plan.execute) {
        throw new RunnerError(
          'TRANSFER_PLAN_REQUIRED',
          'the task transfer was neither performed nor executable, so the required work cannot be proven'
        );
      }
      hash = await plan.execute();
    }
    if (typeof hash !== 'string' || !HASH_RE.test(hash)) {
      throw new RunnerError('TRANSFER_NOT_OBSERVED', 'the task transfer produced no 32-byte transaction hash');
    }

    let settled: Awaited<ReturnType<typeof matchedFinalizedReceipt>>;
    try {
      settled = await matchedFinalizedReceipt(this.config.primary, this.config.secondary, hash);
    } catch (error) {
      const text = messageOf(error);
      throw new RunnerError(
        text.includes('MISMATCH') ? 'TRANSFER_RPC_CONFLICT' : 'TRANSFER_NOT_FINALIZED',
        text
      );
    }
    if (settled.receipt.status !== 'success') {
      throw new RunnerError('TRANSFER_NOT_FINALIZED', `task transfer ${hash} reverted`);
    }

    // Decode EVERY token's Transfer logs, not only the required token's.
    // Filtering by token first would silently drop a transfer in the wrong
    // token, making "the wrong token was paid" indistinguishable from "nothing
    // was paid", which would misreport a real protocol violation as a mere
    // absence.
    const decoded = decodeTokenTransfers(settled.receipt.logs as readonly TransferLog[]);
    const inToken = decoded.filter(
      (row): row is DecodedTransfer & { readonly token: Address } =>
        row.token !== null && sameAddress(row.token, requirement.token)
    );
    // The terms are satisfied first. A receipt may legitimately contain Transfer
    // logs from other tokens alongside the required one, so an unrelated token
    // moving is only a problem when the required payment did not happen.
    const matching = inToken.filter(
      row => sameAddress(row.to, requirement.recipient) && BigInt(row.value) === requirement.amountAtomic
    );
    if (matching.length !== 1) {
      throw this.transferDiscordance(hash, requirement, decoded, inToken, matching.length);
    }
    const sender = matching[0]!.from;
    if (!sameAddress(sender, job.provider)) {
      throw new RunnerError(
        'TRANSFER_MISMATCH',
        `task transfer was sent by ${sender}, not the job provider ${job.provider}`
      );
    }

    const observation = await this.finalizedHead();
    // Every row in `matching` came from a log emitted by `requirement.token`,
    // because `inToken` discarded every other token's logs above. So the token
    // that actually moved is the required one, and reporting it back is the
    // observed fact rather than an echo of the config.
    return {
      transactionHash: hash,
      blockNumber: settled.receipt.blockNumber,
      blockHash: settled.receipt.blockHash,
      timestamp: settled.block.timestamp,
      token: requirement.token,
      sender,
      recipient: requirement.recipient,
      amountAtomic: requirement.amountAtomic,
    };
  }

  private async bindDelivery(
    job: JobData,
    material: PrivateDeliveryMaterial,
    executed: Record<string, unknown>,
    transfer: ObservedTransfer,
    observation: CanonicalFinalizedBlock
  ): Promise<PreparedDelivery> {
    if (typeof material.schema !== 'string' || material.schema.length === 0 || material.schema.length > 128) {
      throw new RunnerError('PRIVATE_INPUT_INVALID', 'the private input schema must be a non-empty string of at most 128 characters');
    }
    if (typeof material.kind !== 'string' || material.kind.length === 0 || material.kind.length > 128) {
      throw new RunnerError('PRIVATE_INPUT_INVALID', 'the private input kind must be a non-empty string of at most 128 characters');
    }
    if (!material.content || typeof material.content !== 'object' || Array.isArray(material.content)) {
      throw new RunnerError('PRIVATE_INPUT_INVALID', 'the private input content must be a structured object');
    }
    if (!sameAddress(transfer.token, this.config.paymentToken)) {
      // Not reachable from a well-formed settleTransfer(), which only ever
      // reports the token it filtered by. Kept as the invariant guard for the
      // commitment we are about to bind: if the transfer we observed did not
      // move the protocol payment token, its evidence is not the work.
      throw new RunnerError(
        'TRANSFER_MISMATCH',
        `task transfer moved ${transfer.token}, but the protocol payment token is ${this.config.paymentToken}`
      );
    }

    const delivery: PrivateDeliveryInput = {
      schema: material.schema,
      kind: material.kind,
      // The runner writes the real, verified transfer hash into the committed
      // payload itself, so an executor cannot claim a transfer that never
      // happened and the commitment can never disagree with the receipt.
      content: { ...executed, transferTx: transfer.transactionHash },
    };

    let validated: PrivateDeliveryInput;
    try {
      validated = privateDeliverySchema.parse(delivery);
    } catch (error) {
      throw new RunnerError('PRIVATE_INPUT_INVALID', `the assembled delivery payload is not canonical: ${messageOf(error)}`);
    }

    let salt: Hex;
    try {
      validateSalt(material.salt, 32);
      salt = material.salt;
    } catch (error) {
      throw new RunnerError('PRIVATE_INPUT_INVALID', messageOf(error));
    }

    let commitment: Hex;
    try {
      commitment = createDeliveryCommitment(this.config.jobId, validated, salt).commitment;
    } catch (error) {
      throw new RunnerError('COMMITMENT_INVALID', messageOf(error));
    }
    if (!HASH_RE.test(commitment) || ZERO_WORD.test(commitment)) {
      throw new RunnerError('COMMITMENT_INVALID', 'the computed delivery commitment is not a non-zero 32-byte value');
    }

    let request: ContractRequest;
    try {
      request = buildSubmitRequest(
        {
          jobId: this.config.jobId,
          deliveryCommitment: commitment,
          provider: job.provider,
        },
        this.config.addresses,
        this.config.chainId ?? MONAD_TESTNET_CHAIN_ID
      );
    } catch (error) {
      throw new RunnerError('REQUEST_INVALID', messageOf(error));
    }

    return { delivery: validated, commitment, transfer, request, observation, job };
  }

  // -- stage 4/5: broadcast and verify --------------------------------------

  private async verifySubmission(
    job: JobData,
    request: ContractRequest,
    expectedCommitment: Hex,
    transactionHash: Hex
  ): Promise<ObservedSubmission> {
    let settled: Awaited<ReturnType<typeof matchedFinalizedReceipt>>;
    try {
      settled = await matchedFinalizedReceipt(this.config.primary, this.config.secondary, transactionHash);
    } catch (error) {
      const text = messageOf(error);
      throw new RunnerError(
        text.includes('MISMATCH') ? 'RECEIPT_RPC_CONFLICT' : 'RECEIPT_NOT_FINALIZED',
        text
      );
    }
    if (settled.receipt.status !== 'success') {
      throw new RunnerError('SUBMISSION_REVERTED', `${request.functionName} reverted in ${transactionHash}`);
    }
    if (!sameAddress(settled.receipt.to, this.config.addresses.protocol)) {
      throw new RunnerError(
        'RECEIPT_MISSING_EVENT',
        `receipt ${transactionHash} targeted ${settled.receipt.to}, not the protocol ${this.config.addresses.protocol}`
      );
    }

    const submissions = settled.receipt.logs
      .filter(log => sameAddress(log.address, this.config.addresses.protocol))
      .flatMap(log => {
        try {
          return [
            decodeEventLog({
              abi: deliveryProtocolAbi,
              eventName: 'DeliverySubmitted',
              data: log.data,
              topics: log.topics as [Hex, ...Hex[]],
            }),
          ];
        } catch {
          // A log the protocol emitted that is not DeliverySubmitted (for
          // example an unrelated approval) is not submission evidence and is
          // skipped rather than treated as a partial success.
          return [];
        }
      })
      .filter(event => event.eventName === 'DeliverySubmitted');

    if (submissions.length === 0) {
      throw new RunnerError(
        'RECEIPT_MISSING_EVENT',
        `receipt ${transactionHash} contains no DeliverySubmitted event from the protocol`
      );
    }
    if (submissions.length > 1) {
      throw new RunnerError(
        'RECEIPT_EVENT_AMBIGUOUS',
        `receipt ${transactionHash} contains ${submissions.length} DeliverySubmitted events`
      );
    }

    const args = submissions[0]!.args as { jobId: bigint; provider: Address; deliveryCommitment: Hex };
    if (args.jobId !== this.config.jobId) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        `receipt proves DeliverySubmitted for job ${args.jobId}, not ${this.config.jobId}`
      );
    }
    if (!sameAddress(args.provider, request.from ?? job.provider)) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        `receipt proves the provider ${args.provider}, not ${job.provider}`
      );
    }
    if (args.deliveryCommitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        `receipt proves deliveryCommitment ${args.deliveryCommitment}, not the prepared ${expectedCommitment}`
      );
    }

    // Close the loop on chain state at the block both RPCs agreed on: the job
    // must actually read back Submitted with this commitment, so a receipt
    // whose log is not reflected in storage would not pass.
    const minedBlock = settled.block.number;
    const minedHash = settled.block.hash;
    if (minedBlock === null || minedHash === null) {
      throw new RunnerError('RECEIPT_NOT_FINALIZED', `the submission block is pending, not mined`);
    }
    // Historical state at the mined block, from BOTH readers. A log that is not
    // reflected in storage is not proof, and one RPC's word for that storage is
    // equally not proof — especially at a historical block, which is exactly
    // what a pruned or lying endpoint gets wrong.
    let observedJob: JobData;
    try {
      observedJob = await matchedCanonicalJobHere(
        this.config.primary,
        this.config.secondary,
        this.config.addresses.protocol,
        this.config.jobId,
        minedBlock
      );
    } catch (error) {
      throw new RunnerError(
        messageOf(error).includes('RPC_STATE_MISMATCH') ? 'RECEIPT_RPC_CONFLICT' : 'JOB_READ_FAILED',
        messageOf(error)
      );
    }
    if (observedJob.status !== CANONICAL_JOB_STATUS.Submitted) {
      throw new RunnerError(
        'RECEIPT_MISSING_EVENT',
        `job ${this.config.jobId} reads status ${jobStatusName(observedJob.status)} at block ${minedBlock}`
      );
    }
    if (observedJob.deliveryCommitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        `job ${this.config.jobId} carries deliveryCommitment ${observedJob.deliveryCommitment}`
      );
    }

    const observation = await this.finalizedHead();
    this.record('FINALIZED', `DeliverySubmitted observed in block ${minedBlock} (${minedHash})`);
    return {
      transactionHash,
      blockNumber: settled.receipt.blockNumber,
      blockHash: settled.receipt.blockHash,
      timestamp: settled.block.timestamp,
      deliveryCommitment: args.deliveryCommitment,
      observation,
    };
  }

  // -- shared ---------------------------------------------------------------

  /**
   * The finalized head, as observed by BOTH readers.
   *
   * This was primary-only, which quietly voided the runner's central claim: the
   * finality observation attached to every FINALIZED result came from a single
   * RPC. Both readers must now return the same block, hash and timestamp, or
   * the observation is not evidence of anything.
   */
  // -- shared ---------------------------------------------------------------

  /**
   * Explain why a receipt did not carry exactly one qualifying transfer.
   *
   * Failure taxonomy is a real surface, not decoration: an integrator deciding
   * whether to retry needs to know that the money moved in the wrong token
   * (a terms violation worth alerting on) rather than that no transfer was
   * observed (may simply be a pending transaction). Those cases share a code so
   * only if nothing distinguishes them, and here something does.
   */
  private transferDiscordance(
    hash: Hex,
    requirement: TaskTransferRequirement,
    decoded: readonly DecodedTransfer[],
    inToken: readonly (DecodedTransfer & { readonly token: Address })[],
    count: number
  ): RunnerError {
    if (count === 0) {
      // Prefer the most specific true statement about what the receipt shows.
      // Ordered so a wrong amount is reported before a foreign token, because a
      // shortfall in the correct token is a subtler error than an obvious one.
      const wrongRecipient = inToken.filter(row => BigInt(row.value) === requirement.amountAtomic);
      const wrongAmount = inToken.filter(row => sameAddress(row.to, requirement.recipient));
      if (wrongRecipient.length > 0) {
        return new RunnerError(
          'TRANSFER_MISMATCH',
          `receipt ${hash} sent ${requirement.amountAtomic} of the protocol token to ${wrongRecipient[0]!.to}, not the required recipient ${requirement.recipient}`
        );
      }
      if (wrongAmount.length > 0) {
        return new RunnerError(
          'TRANSFER_NOT_OBSERVED',
          `receipt ${hash} moved ${wrongAmount[0]!.value} of the protocol token, not the required ${requirement.amountAtomic}`
        );
      }
      if (decoded.length > 0) {
        const moved = decoded[0]!;
        return new RunnerError(
          'TRANSFER_TOKEN_MISMATCH',
          `receipt ${hash} moved ${moved.value} of ${moved.token}, not the protocol payment token ${requirement.token}`
        );
      }
      return new RunnerError(
        'TRANSFER_NOT_OBSERVED',
        `receipt ${hash} carries no Transfer log at all, so the required work is unproven`
      );
    }
    return new RunnerError(
      'TRANSFER_MISMATCH',
      `receipt ${hash} carries ${count} transfers that each satisfy the terms, so the one required payment is ambiguous`
    );
  }

  private async finalizedHead(): Promise<CanonicalFinalizedBlock> {
    try {
      return await matchedFinalizedHeadHere(this.config.primary, this.config.secondary);
    } catch (error) {
      throw new RunnerError('RECEIPT_RPC_CONFLICT', messageOf(error));
    }
  }

  private requireSigner(): ProviderSigner {
    if (!this.config.signer || typeof this.config.signer.sendTransaction !== 'function') {
      throw new RunnerError(
        'SIGNER_REQUIRED',
        'no signer was injected, so this runner cannot broadcast; it will not simulate a transaction'
      );
    }
    return this.config.signer;
  }

  private record(status: RunStatus, detail: string): void {
    this.steps.push({ status, detail });
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/**
 * Read one canonical job from BOTH readers and require them to agree.
 *
 * `readCanonicalJob` from canonical-chain is single-reader by design, and this
 * module may not edit that shared primitive. So the dual-read loop lives here,
 * using the shared `sameCanonicalJob` comparator so the notion of "agree" is
 * defined in exactly one place rather than re-invented locally.
 *
 * A reader that throws is not tolerated either: a disagreement and an
 * unavailable RPC both mean the evidence is incomplete, so both raise
 * RPC_STATE_MISMATCH and neither can yield a prepared or finalized result.
 */
async function matchedCanonicalJobHere(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader,
  protocol: Address,
  jobId: bigint,
  blockNumber?: bigint
): Promise<JobData> {
  // Assert the chain on BOTH readers first, for the same reason the shared
  // primitives do: job state is only interpretable on Monad Testnet, and a
  // reader on another chain must not be allowed to "agree" with the primary.
  await assertMonadTestnet(primary, 'PRIMARY_WRONG_CHAIN');
  await assertMonadTestnet(secondary, 'SECONDARY_WRONG_CHAIN');
  const [primaryJob, secondaryJob] = await Promise.all([
    readCanonicalJob(primary, protocol, jobId, blockNumber),
    readCanonicalJob(secondary, protocol, jobId, blockNumber),
  ]);
  if (!sameCanonicalJob(primaryJob, secondaryJob)) {
    throw new Error(
      `RPC_STATE_MISMATCH: readers disagree on job ${jobId}${blockNumber === undefined ? '' : ` at block ${blockNumber}`}`
    );
  }
  return primaryJob;
}

/**
 * Observe the finalized head from BOTH readers and require identity.
 *
 * `finalizedHead` was primary-only, which meant the finality timestamp and block
 * hash attached to a FINALIZED result came from one RPC. Two readers must agree
 * on the same block for that observation to count as evidence.
 */
async function matchedFinalizedHeadHere(
  primary: CanonicalChainReader,
  secondary: CanonicalChainReader
): Promise<CanonicalFinalizedBlock> {
  await assertMonadTestnet(primary, 'PRIMARY_WRONG_CHAIN');
  await assertMonadTestnet(secondary, 'SECONDARY_WRONG_CHAIN');
  const [primaryHead, secondaryHead] = await Promise.all([finalizedBlock(primary), finalizedBlock(secondary)]);
  if (
    primaryHead.hash !== secondaryHead.hash ||
    primaryHead.number !== secondaryHead.number ||
    primaryHead.timestamp !== secondaryHead.timestamp
  ) {
    throw new Error(
      `RPC_FINALITY_MISMATCH: readers disagree on the finalized head (primary ${primaryHead.number}, secondary ${secondaryHead.number})`
    );
  }
  return primaryHead;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * One decoded ERC-20 transfer, remembered with the token that emitted it.
 *
 * `token` is the emitting address rather than the required payment token: the
 * runner must be able to tell "the wrong token was paid" from "nothing was
 * paid", and those two cases need different failure codes.
 */
interface DecodedTransfer {
  readonly token: Address | null;
  readonly from: Address;
  readonly to: Address;
  readonly value: string;
}

/**
 * Decode every Transfer log in a receipt, whatever token emitted it.
 *
 * `tokenTransfers` from chain-primitives filters by token before decoding, so
 * it cannot report what the other tokens did. This keeps the same strict
 * decoding — a log that is not a well-formed Transfer is dropped, exactly as
 * the shared primitive does — but preserves the emitter address.
 */
function decodeTokenTransfers(logs: readonly TransferLog[]): readonly DecodedTransfer[] {
  const rows: DecodedTransfer[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({
        abi: TRANSFER_EVENT_ABI,
        eventName: 'Transfer',
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      rows.push({
        token: typeof log.address === 'string' ? (log.address as Address) : null,
        from: decoded.args.from,
        to: decoded.args.to,
        value: decoded.args.value.toString(),
      });
    } catch {
      // Not a Transfer log from any token: irrelevant to the required payment.
    }
  }
  return rows;
}

function toJobView(jobId: bigint, job: JobData): ProviderJobView {
  return {
    jobId,
    buyer: job.buyer,
    provider: job.provider,
    attestor: job.attestor,
    termsCommitment: job.termsCommitment,
    budget: job.budget,
    expiresAt: job.expiresAt,
    status: job.status,
  };
}

function jobStatusName(status: number): string {
  const entry = Object.entries(CANONICAL_JOB_STATUS).find(([, value]) => value === status);
  return entry ? entry[0] : `status ${status}`;
}

function validateTransferRequirement(requirement: TaskTransferRequirement): void {
  if (!requirement || typeof requirement !== 'object') {
    throw new RunnerError('TRANSFER_PLAN_REQUIRED', 'a task transfer requirement is required');
  }
  if (typeof requirement.token !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(requirement.token)) {
    throw new RunnerError('TRANSFER_MISMATCH', 'the task transfer token must be an address');
  }
  if (typeof requirement.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(requirement.recipient)) {
    throw new RunnerError('TRANSFER_MISMATCH', 'the task transfer recipient must be an address');
  }
  if (/^0x0{40}$/i.test(requirement.recipient)) {
    throw new RunnerError('TRANSFER_MISMATCH', 'the task transfer recipient must not be the zero address');
  }
  if (typeof requirement.amountAtomic !== 'bigint' || requirement.amountAtomic <= 0n) {
    throw new RunnerError('TRANSFER_MISMATCH', 'the task transfer amount must be a positive bigint');
  }
  if (requirement.observedTransactionHash !== undefined && !HASH_RE.test(requirement.observedTransactionHash)) {
    throw new RunnerError('TRANSFER_NOT_OBSERVED', 'an observed transfer hash must be a 32-byte value');
  }
}

/**
 * Validate the observed hash declared on a plan, which is where an integrator
 * that kept its proof beside the terms puts it.
 *
 * A missing hash is not an error here: that path is legitimate whenever the
 * integrator supplies `execute` instead, and stage 3 is what reports a plan
 * that can neither prove the transfer nor perform it.
 */
function validateObservedTransferHash(observedTransactionHash: Hex | undefined): void {
  if (observedTransactionHash !== undefined && !HASH_RE.test(observedTransactionHash)) {
    throw new RunnerError('TRANSFER_NOT_OBSERVED', 'an observed transfer hash must be a 32-byte value');
  }
}

export { validateTransferRequirement };
