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
  /**
   * The `submitDelivery` transaction hash this runner broadcast, when one is known.
   *
   * Present on every status after a successful send — `FINALIZED`, the pending
   * `SUBMITTED`, and any final failure that came after a hash existed — because
   * it is the anchor for recovery. A caller holding this hash calls `settle()`
   * instead of broadcasting again; a caller without it can only resend, and
   * resending is a second transaction for a job the first may already carry on
   * chain. Losing the hash is how an interrupted run becomes a duplicate spend.
   *
   * Absent, not null, when no send was ever attempted.
   */
  readonly transactionHash?: Hex;
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
  /**
   * The salt that produced `commitment`.
   *
   * Present on this object so that `settle()` can prove the delivery payload is
   * the one the protocol committed to: recomputing the commitment from
   * `delivery` and this salt, and requiring it to equal `commitment`, is the only
   * check that ties a caller-supplied payload to an on-chain fact. Without it the
   * payload would be an unbacked assertion, and `settle()` must not read a
   * locator out of one.
   *
   * This is the one private value the recovery path requires, because the
   * recovery path's job is to re-prove something the runner itself committed.
   * An interrupted client keeps this object; a hostile one still cannot forge a
   * payload that survives the check.
   */
  readonly salt: Hex;
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

// ---------------------------------------------------------------------------
// Runner-authored failure text
// ---------------------------------------------------------------------------

/**
 * Every string below is written by this module and interpolates nothing.
 *
 * `RunnerError` messages, `RunStep` records, and `RunEvidence` are public
 * output. The runner is the component a UI, a log aggregator, and another
 * program all read, and several of the things that feed it are written by
 * someone else about work the runner cannot see:
 *
 *   - an executor that throws may quote the payload, or the private input it was
 *     handed, or its own stack;
 *   - a private-input provider that throws may quote the job it was given;
 *   - a signer's rejection reason quotes the transaction it refused, and its
 *     own transport errors, including authorization headers;
 *   - a task-transfer hook throws about the request it was about to send;
 *   - an injected RPC reader's transport error carries its endpoint URL, its
 *     API key, and the request body it failed on.
 *
 * None of that is safe to forward. So the runner emits its own stable text and
 * keeps the code as the contract — a caller branches on `.code` and a human
 * reads a sentence that says which stage failed without saying what it saw.
 * Interpolating anything here would re-open the hole for every future caller.
 *
 * The one exception is the `settle()` payload proof below, which is deliberately
 * not a message but a recomputation: see `provePayloadBindsCommitment`.
 */
const EXECUTION_FAILURE_MESSAGE =
  'the task executor threw instead of returning a result; the run is not executable';
/** The executor returned `{ ok: false }` rather than a delivery. */
const EXECUTION_DECLINED_MESSAGE =
  'the task executor declined to produce a delivery; the run is not executable';
const PRIVATE_INPUT_THROWN =
  'the private input provider threw instead of returning material';
const SEND_REJECTED_MESSAGE =
  'the signer refused the submitDelivery request; no transaction was broadcast and nothing was submitted';
/** The transfer hook threw instead of returning the hash of the transfer it performed. */
const TRANSFER_HOOK_THREW =
  'the task transfer hook threw instead of performing the required work';
/** The delivery payload does not hash to the commitment the job actually carries. */
const PAYLOAD_COMMITMENT_MISMATCH =
  'the prepared delivery payload does not reproduce the delivery commitment the job carries on chain';
/** The recovery payload is present but carries no salt, so it cannot be proven. */
const PREPARED_SALT_MISSING =
  'the prepared delivery carries a payload but no salt, so it cannot be proven to belong to this job';
/** The recovery salt was missing or malformed, so no payload can be proven at all. */
const PREPARED_SALT_INVALID =
  'the prepared delivery payload cannot be proven because the recovery salt is not a 32-byte hex value';
/** The payload failed the runner's own canonical schema, without echoing which field or value. */
const PAYLOAD_NOT_CANONICAL =
  'the assembled delivery payload does not satisfy the canonical delivery schema';
/** A commitment could not be computed from the validated payload and salt. */
const COMMITMENT_NOT_COMPUTABLE =
  'the delivery commitment could not be computed from the validated payload';
/** The canonical submitDelivery request could not be built from this runner's configuration. */
const REQUEST_NOT_BUILDABLE =
  'the canonical submitDelivery request could not be built from this runner configuration';
/** The two readers disagreed about finalized chain state; no single answer exists. */
const READERS_DISAGREE =
  'the two RPC readers reported conflicting finalized chain state, so no single answer exists';
/** A reader could not answer a job read at all. */
const READ_JOB_NOT_AVAILABLE =
  'the RPC readers could not return the job state, so the run cannot be grounded';
/** The two readers described the same transaction differently. */
const FINALITY_MISMATCH =
  'the two RPC readers reported conflicting finalized evidence for the same transaction';
/** The receipt exists on some reader but is not usable as proof yet. */
const RECEIPT_NOT_USABLE_YET =
  'the transaction receipt is not usable as proof yet; reconcile with settle() using the returned hash';
/** The transfer receipt exists but is not usable as proof yet. */
const TRANSFER_NOT_USABLE_YET =
  'the task transfer receipt is not usable as proof yet';
/**
 * A broadcast is real but its receipt has not landed yet.
 *
 * Says what the caller must do — reconcile with `settle()` using the hash — so
 * the message itself carries the instruction that makes the hash useful. It
 * deliberately names no transaction, block, or endpoint.
 */
const BROADCAST_NOT_YET_FINAL =
  'the submission was broadcast and its hash is known, but its receipt is not finalized yet. ' +
  'Reconcile with settle() using the returned hash; do not resend.';

/**
 * Errors that must stay final rather than be relabelled pending.
 *
 * A pending status exists to describe the absence of evidence. A dual-RPC
 * conflict is the opposite: two independent readers answered differently, so
 * there is evidence of disagreement and no single answer to build on. Choosing
 * "not final" over "conflicted" would let one cooperating pair of endpoints turn
 * a disagreement into a benign wait, which is exactly how an attacker who
 * controls one reader buys time to decide what the runner believes.
 */
/** The injected signer is not the provider that owns the job on chain. */
const SIGNER_NOT_PROVIDER_MESSAGE =
  'the injected signer is not the provider the job names on chain, so it cannot submit for this job';
/** The job is not in a state that accepts a delivery. */
const JOB_NOT_FUNDED_MESSAGE =
  'the job is not in a state that accepts a delivery';
/** The job cannot be submitted to in its current state. */
const JOB_NOT_SUBMITTABLE_MESSAGE =
  'the job is not in a state that accepts a submission';
/** The job already carries a delivery commitment, so submitting again would revert. */
const JOB_ALREADY_CARRIES_COMMITMENT_MESSAGE =
  'the job already carries a delivery commitment, so submitting again would revert';
/** The chain says the job has not been submitted yet, which settle() requires. */
const JOB_NOT_YET_SUBMITTED_MESSAGE =
  'the job has not been submitted on chain yet; settle() expects a submission that has already landed';
/** The finalized transfer receipt says the transfer itself reverted. */
const TRANSFER_REVERTED_MESSAGE =
  'the task transfer receipt shows the transfer reverted, so the required work was not performed';
/** The transfer was sent by an address that is not the job provider. */
const TRANSFER_SENDER_MISMATCH_MESSAGE =
  'the task transfer was sent by an address that is not the job provider';
/** Two spellings of the payment token in this configuration disagree. */
const TRANSFER_TOKEN_DISAGREEMENT_MESSAGE =
  'the token the transfer moved is not the protocol payment token this run is bound to';

/**
 * A broadcast whose finalized receipt says it reverted.
 *
 * Says the submission is done and failed, not that it is unconfirmed — the two
 * look alike to a caller who only reads the status, and the difference is the
 * whole point: a revert is a conclusion, a pending receipt is a wait.
 */
const SUBMISSION_REVERTED_MESSAGE =
  'the submission was broadcast and reverted on chain; the delivery was not submitted';

/** The submission receipt targeted a contract that is not the protocol. */
const RECEIPT_WRONG_TARGET_MESSAGE =
  'the submission receipt targeted a contract that is not the delivery protocol';
/** The submission receipt carries no DeliverySubmitted event from the protocol. */
const RECEIPT_NO_SUBMISSION_EVENT_MESSAGE =
  'the submission receipt carries no DeliverySubmitted event from the delivery protocol';
/** The submission receipt carries more than one DeliverySubmitted event. */
const RECEIPT_SUBMISSION_EVENTS_AMBIGUOUS_MESSAGE =
  'the submission receipt carries more than one DeliverySubmitted event, so the submission proven is ambiguous';
/** The receipt's event names a job other than the one this runner selected. */
const RECEIPT_WRONG_JOB_MESSAGE =
  'the submission receipt proves a delivery for a different job';
/** The receipt's event names a provider other than the one the job names on chain. */
const RECEIPT_WRONG_PROVIDER_MESSAGE =
  'the submission receipt names a provider other than the one the job carries on chain';
/** The receipt's event names a commitment other than the one this run built. */
const RECEIPT_WRONG_COMMITMENT_MESSAGE =
  'the submission receipt names a delivery commitment other than the one this run computed';
/** Job storage at the mined block does not reflect the submitted log. */
const RECEIPT_STORAGE_NOT_REFLECTED_MESSAGE =
  'job storage does not reflect the submitted event at the block where it was mined';
/** Job storage at the mined block carries a different commitment. */
const RECEIPT_STORAGE_COMMITMENT_MISMATCH_MESSAGE =
  'job storage carries a delivery commitment other than the one this run computed';
/** A transfer that satisfies the terms was paid, but to someone else. */
const TRANSFER_WRONG_RECIPIENT_MESSAGE =
  'the task transfer paid the required amount to a recipient that is not the required one';
/** A transfer of the protocol token moved, but of the wrong amount. */
const TRANSFER_WRONG_AMOUNT_MESSAGE =
  'the task transfer moved an amount of the protocol token other than the required one';
/** The transfer receipt carries no token Transfer log at all. */
const TRANSFER_NO_LOG_MESSAGE =
  'the task transfer receipt carries no token transfer, so the required work is unproven';
/** More than one transfer satisfies the terms. */
const TRANSFER_AMBIGUOUS_MESSAGE =
  'the task transfer receipt carries more than one transfer that satisfies the terms';

const NEVER_PENDING_CODES: readonly RunFailureCode[] = [
  'RECEIPT_RPC_CONFLICT',
  'TRANSFER_RPC_CONFLICT',
];

/** Whether a runner error is a finality conflict, which may never be reported pending. */
function isFinalityConflict(error: RunnerError): boolean {
  return NEVER_PENDING_CODES.includes(error.code);
}

/**
 * Read the transfer locator out of a proven delivery payload.
 *
 * The locator is `content.transferTx` — the same field `bindDelivery` writes when
 * it records which transfer satisfied the job. It is read only from a payload
 * whose commitment has already been recomputed and matched, so the value here is
 * the one this run itself put into the commitment. Returning `undefined` when the
 * field is absent or not a 32-byte value makes "no locator" and "bad locator"
 * both non-fatal: `settleTransfer` then falls back to the config-supplied hash
 * and re-derives the terms from chain state as it always does.
 */
function extractTransferLocator(delivery: PrivateDeliveryInput): Hex | undefined {
  const content = delivery.content;
  const raw = content !== undefined && typeof content === 'object' ? content.transferTx : undefined;
  return typeof raw === 'string' && /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as Hex) : undefined;
}

export class ProviderRunner {
  private readonly steps: RunStep[] = [];
  /**
   * The token and requirement accepted at construction.
   *
   * The config object is held by reference and is not frozen, so a caller can
   * replace `paymentToken` or `requirement.token` after `new` and before
   * `prepare()`. Later stages read `this.config` again. These copies are what
   * those stages compare against, so a mutation cannot move the check that
   * already passed.
   */
  private readonly acceptedPaymentToken: Address;
  private readonly acceptedRequirement: TaskTransferRequirement;
  /** The plan-level locator accepted at construction, if one was configured. */
  private readonly acceptedPlanLocator: Hex | undefined;
  /**
   * The transfer plan object accepted at construction.
   *
   * Field copies do not cover a replacement plan whose token, recipient,
   * amount, and hashes match but whose execute hook is different. The hook is
   * a capability, so the object itself is what later stages must still hold.
   */
  private readonly acceptedTransfer: TaskTransferPlan;
  /**
   * The execute hook accepted at construction, or undefined when the plan has
   * none. Object identity does not cover a later assignment to `execute` on
   * the same plan, and that hook is what settleTransfer calls.
   */
  private readonly acceptedExecute: TaskTransferPlan['execute'];

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
    // Compare the two spellings of "the token this job pays in" now, in the
    // constructor, before a single stage has run. They are configured in two
    // places by the integrator, and a mismatch is not something chain state can
    // reveal: a delivery would be paid in one token and bound against another,
    // and the job would settle as if it had earned a payment it never received.
    //
    // Catching it here is also the only place it is free. Downstream the failure
    // arrives after the private input has been decrypted, the executor has run,
    // and possibly a transfer has already been broadcast — at which point the
    // misconfiguration has already cost a call, a secret, or money.
    //
    // The comparison is case-insensitive because these are EIP-55 addresses
    // written by different tools, which differ in checksum casing while naming
    // the same contract.
    //
    // TRANSFER_TOKEN_MISMATCH rather than the broader TRANSFER_MISMATCH: the
    // config is disagreeing with itself about which token this job pays in, and
    // a caller triaging by code should not have to look at chain state that was
    // never read to tell that apart from a chain-observed wrong token.
    if (!sameAddress(config.transfer.requirement.token, config.paymentToken)) {
      throw new RunnerError(
        'TRANSFER_TOKEN_MISMATCH',
        'the configured payment token and the required task transfer token do not agree'
      );
    }
    this.acceptedPaymentToken = config.paymentToken;
    this.acceptedTransfer = config.transfer;
    this.acceptedExecute = config.transfer.execute;
    this.acceptedPlanLocator = config.transfer.observedTransactionHash;
    this.acceptedRequirement = {
      token: config.transfer.requirement.token,
      recipient: config.transfer.requirement.recipient,
      amountAtomic: config.transfer.requirement.amountAtomic,
      observedTransactionHash: config.transfer.requirement.observedTransactionHash,
    };
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
    this.recheckAcceptedTokens();
    const { job, observation } = await this.selectJob();
    const material = await this.readPrivateInput(job);
    const executed = await this.executeTask(job, material);
    const settledTransfer = await this.settleTransfer(job);
    const transfer = settledTransfer.transfer;
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
   *
   * The `salt` on the prepared delivery is what turns `prepared.delivery` from an
   * assertion into evidence: the runner recomputes the commitment from the
   * payload and the salt, and requires it to equal the commitment the job carries
   * on chain. A caller who lost or fabricated the salt cannot pass that check.
   */
  async settle(prepared: PreparedDelivery, transactionHash: Hex): Promise<RunOutcome> {
    this.recheckAcceptedTokens();
    if (!prepared || typeof prepared.commitment !== 'string' || !HASH_RE.test(prepared.commitment)) {
      throw new RunnerError('COMMITMENT_INVALID', 'prepared delivery with a valid commitment is required');
    }
    if (!prepared.job) {
      throw new RunnerError('JOB_READ_FAILED', 'the prepared delivery must carry the job that was selected');
    }
    if (typeof transactionHash !== 'string' || !HASH_RE.test(transactionHash)) {
      throw new RunnerError('SUBMISSION_NOT_OBSERVED', 'a 32-byte transaction hash is required to settle');
    }
    // Prove the payload before reading anything out of it. Recovery input comes
    // from whoever resumes the run, so `prepared.delivery` is caller-controlled
    // data: the transfer locator inside it is only trustworthy once the payload
    // carrying that locator has been shown to hash back to the commitment this
    // run put on chain. Proving it first means a forged payload can never direct
    // a re-observing read.
    let observedJob: JobData;
    let recoveredHash: Hex | undefined;
    if (prepared.delivery !== undefined) {
      // Prove the payload before reading anything out of it. Recovery input comes
      // from whoever resumes the run, so `prepared.delivery` is caller-controlled
      // data: the transfer locator inside it is only trustworthy once the payload
      // carrying that locator has been shown to hash back to the commitment this
      // run put on chain. Proving it first means a forged payload can never direct
      // a re-observing read.
      //
      // The salt it needs is part of the same proof, so a caller who cannot
      // reproduce the commitment cannot pass any part of this branch.
      const salt = prepared.salt;
      if (salt !== undefined) {
        this.provePayloadBindsCommitment(prepared.commitment, prepared.delivery, salt);
        // The locator only becomes usable once the payload carrying it is proven,
        // so it is read out here rather than trusted from the caller.
        recoveredHash = extractTransferLocator(prepared.delivery);
      } else {
        throw new RunnerError('PRIVATE_INPUT_INVALID', PREPARED_SALT_MISSING);
      }
    }
    // Re-read the job at the finalized head before verifying: this run may be
    // resuming hours later, and an integrator must not be able to settle a hash
    // against a job that has since been cancelled or resolved.
    //
    // Read from BOTH readers. settle() is the recovery path most likely to be
    // run much later against a different RPC endpoint, so one reader's word is
    // not enough to declare the job Submitted.
    try {
      observedJob = await matchedCanonicalJobHere(
        this.config.primary,
        this.config.secondary,
        this.config.addresses.protocol,
        this.config.jobId
      );
    } catch (error) {
      // The readers are caller-injected, so their transport errors can embed an
      // RPC endpoint URL, an API key, or a request body. The sentinel string is
      // what classifies the failure; the message is runner-authored, keyed only
      // to whether the two readers conflicted.
      throw readerFailure(error);
    }
    if (observedJob.status !== CANONICAL_JOB_STATUS.Submitted) {
      throw new RunnerError(
        'JOB_ALREADY_SUBMITTED',
        JOB_NOT_YET_SUBMITTED_MESSAGE
      );
    }
    if (observedJob.deliveryCommitment.toLowerCase() !== prepared.commitment.toLowerCase()) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        PAYLOAD_COMMITMENT_MISMATCH
      );
    }
    if (!sameAddress(this.config.signer?.address ?? observedJob.provider, observedJob.provider)) {
      throw new RunnerError(
        'SIGNER_NOT_PROVIDER',
        SIGNER_NOT_PROVIDER_MESSAGE
      );
    }

    // Re-observe the transfer from both readers rather than trusting the caller's
    // object. settle() runs against a chain that has moved on since the original
    // run, so the transfer's terms must be re-established from canonical state,
    // not replayed from an object an interrupted process was holding.
    const settledTransfer = await this.settleTransfer(observedJob, recoveredHash);
    const transfer = settledTransfer.transfer;
    const transferHead = settledTransfer.observation;

    // Rebuild the canonical request from this runner's own configuration and the
    // chain's own facts. A recovered run may carry a config edited since it
    // started, and the receipt is only evidence for the exact call that produced
    // it — so the request used to verify here is the one this runner computes
    // now, not the one it was handed.
    let request: ContractRequest;
    try {
      request = buildSubmitRequest(
        {
          jobId: this.config.jobId,
          deliveryCommitment: observedJob.deliveryCommitment,
          // The observed provider, not the caller's: the receipt must name the
          // provider the chain says owns the job.
          provider: observedJob.provider,
        },
        this.config.addresses,
        this.config.chainId ?? MONAD_TESTNET_CHAIN_ID
      );
    } catch {
      throw new RunnerError('REQUEST_INVALID', REQUEST_NOT_BUILDABLE);
    }
    // The rebuilt request must be a well-formed canonical call: the same guard
    // prepare() applies to the request it broadcasts.
    if (typeof request.address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(request.address)) {
      throw new RunnerError('REQUEST_INVALID', REQUEST_NOT_BUILDABLE);
    }

    let submission: ObservedSubmission;
    try {
      submission = await this.verifySubmission(observedJob, request, prepared.commitment, transactionHash);
    } catch (error) {
      // A known hash whose receipt is simply not final yet is the case settle()
      // exists for. Throwing here drops the hash the caller just handed over.
      // Disagreement and a reverted receipt stay their own failures: those are
      // settled facts, not an invitation to wait or to broadcast again.
      if (
        error instanceof RunnerError &&
        error.code === 'RECEIPT_NOT_FINALIZED' &&
        !isFinalityConflict(error)
      ) {
        this.record('SUBMITTED', BROADCAST_NOT_YET_FINAL);
        return {
          evidence: {
            status: 'SUBMITTED',
            jobId: this.config.jobId,
            job: observedJob,
            transfer,
            deliveryCommitment: observedJob.deliveryCommitment,
            request,
            transactionHash,
            steps: [...this.steps],
            failure: { code: 'RECEIPT_NOT_FINALIZED', message: BROADCAST_NOT_YET_FINAL },
          },
          prepared: this.sanitizedRecovery(prepared, transfer, request, observedJob, transferHead),
        };
      }
      throw error;
    }
    return {
      evidence: {
        status: 'FINALIZED',
        jobId: this.config.jobId,
        job: observedJob,
        observation: submission.observation,
        transfer,
        submission,
        deliveryCommitment: observedJob.deliveryCommitment,
        request,
        transactionHash,
        steps: [...this.steps],
      },
      prepared: this.sanitizedRecovery(prepared, transfer, request, observedJob, submission.observation),
    };
  }

  /**
   * A recovery handle built only from facts this call just proved.
   *
   * The object `settle()` was given is caller-controlled, including after its
   * commitment has been checked. Returning it would publish a fabricated
   * transfer, request, observation, or job beside evidence that was rebuilt
   * from the chain. The delivery and salt are the proven payload; everything
   * else is replaced with this call's observations.
   */
  private sanitizedRecovery(
    prepared: PreparedDelivery,
    transfer: ObservedTransfer,
    request: ContractRequest,
    job: JobData,
    observation: CanonicalFinalizedBlock
  ): PreparedDelivery {
    return {
      delivery: prepared.delivery,
      commitment: prepared.commitment,
      salt: prepared.salt,
      transfer,
      request,
      observation,
      job,
    };
  }

  /**
   * Stages 1–5: prepare, broadcast the canonical request through the injected
   * signer, and verify the finalized receipt. Requires a signer.
   */
  async run(): Promise<RunOutcome> {
    this.recheckAcceptedTokens();
    const signer = this.requireSigner();
    const { evidence, prepared } = await this.prepare();
    if (evidence.status === 'FAILED' || !prepared) return { evidence };

    this.record('SUBMITTED', 'broadcasting the canonical submitDelivery request');
    const sendOutcome = await signer.sendTransaction(prepared.request);

    if (sendOutcome.kind === 'submitted') {
      this.record('SUBMITTED', 'broadcast returned a transaction hash; nothing is yet proven');

      // Only a genuinely absent or non-final receipt may be relabelled pending.
      // Everything else — a reverted broadcast, a receipt for the wrong job or
      // provider or commitment, two readers that disagree — is settled evidence
      // of a *bad* outcome, not the absence of evidence, and it must fail its
      // own way rather than be laundered into "try again later".
      //
      // Why the hash has to survive: a caller that gets SUBMITTED calls settle()
      // with the hash it was handed instead of broadcasting again. Dropping that
      // hash leaves resending as the only recovery, and resending is a second
      // transaction for a job the first may already be on chain for — a
      // duplicate spend against the protocol, not a retry.
      let verified: ObservedSubmission;
      try {
        verified = await this.verifySubmission(
          prepared.job,
          prepared.request,
          prepared.commitment,
          sendOutcome.transactionHash
        );
      } catch (error) {
        if (
          error instanceof RunnerError &&
          error.code === 'RECEIPT_NOT_FINALIZED' &&
          !isFinalityConflict(error)
        ) {
          this.record('SUBMITTED', BROADCAST_NOT_YET_FINAL);
          return {
            evidence: {
              status: 'SUBMITTED',
              jobId: this.config.jobId,
              job: evidence.job,
              observation: evidence.observation,
              transfer: prepared.transfer,
              deliveryCommitment: prepared.commitment,
              // The canonical request this runner itself built and sent, not a
              // re-derivation: the caller needs the exact call it made.
              request: prepared.request,
              transactionHash: sendOutcome.transactionHash,
              steps: [...this.steps],
              // The hash is described, not echoed here, because `transactionHash`
              // above already carries it in a structured field.
              failure: {
                code: 'RECEIPT_NOT_FINALIZED',
                message: BROADCAST_NOT_YET_FINAL,
              },
            },
            // Retained, so the interrupted client can settle() later.
            prepared,
          };
        }
        // A finalized receipt that says the broadcast reverted. The transaction is
        // real and its hash is known, so — as with any broadcast that produced a
        // hash — the caller must be able to hand that hash to settle() rather than
        // resend. But the *reason* matters more than the status here: a revert is
        // settled evidence of a failed call, so the failure block carries the
        // distinct SUBMISSION_REVERTED code and a message that says the submission
        // itself failed. Reporting this as an ordinary "wait for finality" would
        // tell the caller to keep waiting for a receipt that will never succeed.
        if (error instanceof RunnerError && error.code === 'SUBMISSION_REVERTED') {
          this.record('SUBMITTED', 'submitDelivery reverted on chain');
          return {
            evidence: {
              status: 'SUBMITTED',
              jobId: this.config.jobId,
              job: evidence.job,
              observation: evidence.observation,
              transfer: prepared.transfer,
              deliveryCommitment: prepared.commitment,
              request: prepared.request,
              transactionHash: sendOutcome.transactionHash,
              steps: [...this.steps],
              failure: { code: 'SUBMISSION_REVERTED', message: SUBMISSION_REVERTED_MESSAGE },
            },
            // Deliberately retained. The run is over and will never finalize, but
            // the recovery handle still holds the only correct answer to "what was
            // this job submitted with", which is what a caller reconciling history
            // against on-chain state needs to resolve the revert.
            prepared,
          };
        }
        throw error;
      }
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
          transactionHash: sendOutcome.transactionHash,
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

    // A signer reason is the signer's own sentence about the transaction it
    // refused, and it can name a URL, an authorization header, or the payload
    // it was handed. The step log records that the signer refused, which is the
    // fact the protocol needs, and the reason stays with the signer's own logger.
    this.record('FAILED', 'the signer refused the submitDelivery request');
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
        failure: { code: 'SEND_FAILED', message: SEND_REJECTED_MESSAGE },
      },
      prepared,
    };
  }

  // -- stage 1: select the job ---------------------------------------------

  /**
   * Reject a config whose token or requirement changed after construction.
   *
   * Called at the start of every public method, before private input, the
   * executor, the transfer hook, or the signer. The comparison is the same
   * case-insensitive address check the constructor used.
   */
  private recheckAcceptedTokens(): void {
    const requirement = this.config.transfer?.requirement;
    const planLocator = this.config.transfer?.observedTransactionHash;
    const requirementLocator = requirement?.observedTransactionHash;
    const locatorMoved = (current: Hex | undefined, accepted: Hex | undefined) =>
      (current === undefined) !== (accepted === undefined) ||
      (current !== undefined && accepted !== undefined && !sameHex(current, accepted));
    if (
      this.config.transfer !== this.acceptedTransfer ||
      !requirement ||
      !sameAddress(this.config.paymentToken, this.acceptedPaymentToken) ||
      !sameAddress(requirement.token, this.acceptedRequirement.token) ||
      !sameAddress(requirement.recipient, this.acceptedRequirement.recipient) ||
      requirement.amountAtomic !== this.acceptedRequirement.amountAtomic ||
      locatorMoved(requirementLocator, this.acceptedRequirement.observedTransactionHash) ||
      locatorMoved(planLocator, this.acceptedPlanLocator) ||
      this.config.transfer?.execute !== this.acceptedExecute
    ) {
      throw new RunnerError(
        'TRANSFER_TOKEN_MISMATCH',
        'the configured payment token and the required task transfer token do not agree'
      );
    }
  }

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
      throw readerFailure(error);
    }

    if (this.config.signer && !sameAddress(this.config.signer.address, job.provider)) {
      throw new RunnerError(
        'SIGNER_NOT_PROVIDER',
        SIGNER_NOT_PROVIDER_MESSAGE
      );
    }
    if (job.status === CANONICAL_JOB_STATUS.Proposed || job.status === CANONICAL_JOB_STATUS.Accepted) {
      throw new RunnerError(
        'JOB_NOT_FUNDED',
        JOB_NOT_FUNDED_MESSAGE
      );
    }
    if (job.status === CANONICAL_JOB_STATUS.Submitted ||
        job.status === CANONICAL_JOB_STATUS.Completed ||
        job.status === CANONICAL_JOB_STATUS.Rejected ||
        job.status === CANONICAL_JOB_STATUS.Expired ||
        job.status === CANONICAL_JOB_STATUS.Cancelled) {
      throw new RunnerError(
        'JOB_ALREADY_SUBMITTED',
        JOB_NOT_SUBMITTABLE_MESSAGE
      );
    }
    if (!ZERO_WORD.test(job.deliveryCommitment)) {
      throw new RunnerError(
        'JOB_ALREADY_SUBMITTED',
        JOB_ALREADY_CARRIES_COMMITMENT_MESSAGE
      );
    }

    this.record('SELECTED', `job ${this.config.jobId} is funded and ready to submit`);
    return { job, observation };
  }

  // -- stage 2: private input and real work ---------------------------------

  private async readPrivateInput(job: JobData): Promise<PrivateDeliveryMaterial> {
    if (!this.config.privateInput || typeof this.config.privateInput.provide !== 'function') {
      throw new RunnerError('PRIVATE_INPUT_REQUIRED', 'a private input provider is required');
    }
    // A provider that throws, rather than returning nothing, is a collaborator
    // failure in its own terms. Its message describes what it was handed, so it
    // is not relayed; the code says which collaborator failed.
    let material: PrivateDeliveryMaterial;
    try {
      material = await this.config.privateInput.provide(toJobView(this.config.jobId, job));
    } catch {
      throw new RunnerError('PRIVATE_INPUT_INVALID', PRIVATE_INPUT_THROWN);
    }
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
    let result: TaskExecutionResult;
    try {
      result = await this.config.executor.execute(toJobView(this.config.jobId, job), material);
    } catch {
      // A thrown executor is the same collaborator failure as a returned one:
      // it may quote the payload or the private input it was working on, so its
      // message is dropped and the stable code carries the failure.
      throw new RunnerError('EXECUTION_FAILED', EXECUTION_FAILURE_MESSAGE);
    }
    if (!result || result.ok !== true) {
      // A returned `reason` is the executor's own sentence about the work it just
      // did, and it is written by whoever supplied the executor — which for this
      // runner's threat model is not necessarily a friendly party. It can quote
      // the payload, the private input, or the job it was handed. The code is the
      // contract; the message says the executor declined, and the reason stays
      // with the executor's own logger.
      throw new RunnerError(
        'EXECUTION_FAILED',
        result && result.ok === false ? EXECUTION_DECLINED_MESSAGE : 'the task executor returned no result'
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

  private async settleTransfer(
    job: JobData,
    recoveredHash?: Hex
  ): Promise<{ readonly transfer: ObservedTransfer; readonly observation: CanonicalFinalizedBlock }> {
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

    // Honouring a proven recovery hash over a config-supplied one is the point of
    // the parameter: the caller who resumed this run may no longer have the same
    // config it started with, and the hash is what was checked against the
    // commitment. Only the first two lines of this method care where it came from;
    // everything below re-derives the transfer's terms from chain state.
    let hash: Hex | undefined = plan.observedTransactionHash ?? requirement.observedTransactionHash;
    if (recoveredHash !== undefined && !sameHex(hash ?? recoveredHash, recoveredHash)) {
      throw new RunnerError(
        'TRANSFER_NOT_OBSERVED',
        'the observed transfer hash does not match the hash bound to the delivery commitment'
      );
    }
    if (recoveredHash !== undefined) hash = recoveredHash;
    if (hash === undefined) {
      if (!plan.execute) {
        throw new RunnerError(
          'TRANSFER_PLAN_REQUIRED',
          'the task transfer was neither performed nor executable, so the required work cannot be proven'
        );
      }
      let performed: Hex;
      try {
        performed = await plan.execute();
      } catch {
        // A transfer hook that throws is a collaborator failure whose message
        // quotes the request it was about to send. The stable code reports the
        // hook failed; the integrator's own log carries the detail.
        throw new RunnerError('TRANSFER_PLAN_REQUIRED', TRANSFER_HOOK_THREW);
      }
      if (typeof performed !== 'string' || !HASH_RE.test(performed)) {
        throw new RunnerError('TRANSFER_NOT_OBSERVED', 'the task transfer produced no 32-byte transaction hash');
      }
      hash = performed;
    }

    let settled: Awaited<ReturnType<typeof matchedFinalizedReceipt>>;
    try {
      settled = await matchedFinalizedReceipt(this.config.primary, this.config.secondary, hash);
    } catch (error) {
      throw receiptFailure(error, 'TRANSFER_RPC_CONFLICT', 'TRANSFER_NOT_FINALIZED', TRANSFER_NOT_USABLE_YET);
    }
    if (settled.receipt.status !== 'success') {
      throw new RunnerError('TRANSFER_NOT_FINALIZED', TRANSFER_REVERTED_MESSAGE);
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
        TRANSFER_SENDER_MISMATCH_MESSAGE
      );
    }

    const observation = await this.finalizedHead();
    // Every row in `matching` came from a log emitted by `requirement.token`,
    // because `inToken` discarded every other token's logs above. So the token
    // that actually moved is the required one, and reporting it back is the
    // observed fact rather than an echo of the config.
    return {
      transfer: {
        transactionHash: hash,
        blockNumber: settled.receipt.blockNumber,
        blockHash: settled.receipt.blockHash,
        timestamp: settled.block.timestamp,
        token: requirement.token,
        sender,
        recipient: requirement.recipient,
        amountAtomic: requirement.amountAtomic,
      },
      observation,
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
        TRANSFER_TOKEN_DISAGREEMENT_MESSAGE
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
      throw new RunnerError('PRIVATE_INPUT_INVALID', PAYLOAD_NOT_CANONICAL);
    }

    let salt: Hex;
    try {
      validateSalt(material.salt, 32);
      salt = material.salt;
    } catch {
      throw new RunnerError('PRIVATE_INPUT_INVALID', PREPARED_SALT_INVALID);
    }

    let commitment: Hex;
    try {
      commitment = createDeliveryCommitment(this.config.jobId, validated, salt).commitment;
    } catch {
      throw new RunnerError('COMMITMENT_INVALID', COMMITMENT_NOT_COMPUTABLE);
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
    } catch {
      throw new RunnerError('REQUEST_INVALID', REQUEST_NOT_BUILDABLE);
    }

    return { delivery: validated, commitment, salt, transfer, request, observation, job };
  }

  // -- stage 4/5: broadcast and verify --------------------------------------

  /**
   * Prove a recovery payload really produces the commitment on chain.
   *
   * This is the one place in the runner that checks a value it was handed by
   * re-deriving a fact the protocol holds, rather than reading a subsequent one.
   * A commitment is `hash(jobId, payload, salt)`, so two peaceful callers holding
   * the same commitment are the only way a resumed run and the chain can be
   * talking about the same delivery. Recomputing it and comparing is therefore
   * the only check that distinguishes "the client that prepared this is handing
   * back what it prepared" from "a client is asking the runner to vouch for a
   * payload it never committed to".
   *
   * Why this matters: the payload binds the transfer locator, and the locator is
   * what `settle()` uses to re-observe a transfer and re-issue its report. A
   * payload that survives recomputation may be read; one that does not is
   * refused, and nothing downstream of it runs.
   *
   * Why this is a recomputation and not a message check: the value being proven
   * is caller-supplied, so there is no safe sentence to write about it. The
   * comparison has no message to leak.
   */
  private provePayloadBindsCommitment(
    commitment: Hex,
    delivery: PrivateDeliveryInput,
    salt: Hex | undefined
  ): void {
    if (salt === undefined) {
      throw new RunnerError('PRIVATE_INPUT_INVALID', PREPARED_SALT_MISSING);
    }
    try {
      validateSalt(salt, 32);
    } catch {
      // The salt, not the payload, is what is malformed here, and its value is
      // the caller's: report that the salt is unusable without echoing it.
      throw new RunnerError('PRIVATE_INPUT_INVALID', PREPARED_SALT_INVALID);
    }
    let recomputed: Hex;
    try {
      recomputed = createDeliveryCommitment(this.config.jobId, delivery, salt).commitment;
    } catch {
      // A payload that cannot be hashed at all is not the payload that was
      // committed. The structural reason (a wrong field or schema version) is
      // exactly what a caller probing the validator should not be handed.
      throw new RunnerError('PRIVATE_INPUT_INVALID', PAYLOAD_NOT_CANONICAL);
    }
    if (recomputed.toLowerCase() !== commitment.toLowerCase()) {
      throw new RunnerError('RECEIPT_COMMITMENT_MISMATCH', PAYLOAD_COMMITMENT_MISMATCH);
    }
  }

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
      throw receiptFailure(error, 'RECEIPT_RPC_CONFLICT', 'RECEIPT_NOT_FINALIZED', RECEIPT_NOT_USABLE_YET);
    }
    if (settled.receipt.status !== 'success') {
      throw new RunnerError('SUBMISSION_REVERTED', SUBMISSION_REVERTED_MESSAGE);
    }
    if (!sameAddress(settled.receipt.to, this.config.addresses.protocol)) {
      throw new RunnerError(
        'RECEIPT_MISSING_EVENT',
        RECEIPT_WRONG_TARGET_MESSAGE
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
        RECEIPT_NO_SUBMISSION_EVENT_MESSAGE
      );
    }
    if (submissions.length > 1) {
      throw new RunnerError(
        'RECEIPT_EVENT_AMBIGUOUS',
        RECEIPT_SUBMISSION_EVENTS_AMBIGUOUS_MESSAGE
      );
    }

    const args = submissions[0]!.args as { jobId: bigint; provider: Address; deliveryCommitment: Hex };
    if (args.jobId !== this.config.jobId) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        RECEIPT_WRONG_JOB_MESSAGE
      );
    }
    if (!sameAddress(args.provider, request.from ?? job.provider)) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        RECEIPT_WRONG_PROVIDER_MESSAGE
      );
    }
    if (args.deliveryCommitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        RECEIPT_WRONG_COMMITMENT_MESSAGE
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
      // The readers are caller-injected, so their transport errors can embed an
      // RPC endpoint URL, an API key, or a request body. The sentinel string is
      // what classifies the failure; the message is runner-authored, keyed only
      // to whether the two readers conflicted.
      throw readerFailure(error);
    }
    if (observedJob.status !== CANONICAL_JOB_STATUS.Submitted) {
      throw new RunnerError(
        'RECEIPT_MISSING_EVENT',
        RECEIPT_STORAGE_NOT_REFLECTED_MESSAGE
      );
    }
    if (observedJob.deliveryCommitment.toLowerCase() !== expectedCommitment.toLowerCase()) {
      throw new RunnerError(
        'RECEIPT_COMMITMENT_MISMATCH',
        RECEIPT_STORAGE_COMMITMENT_MISMATCH_MESSAGE
      );
    }

    const observation = await this.finalizedHead();
    this.record('FINALIZED', 'DeliverySubmitted observed in a finalized block agreed by both readers');
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
          TRANSFER_WRONG_RECIPIENT_MESSAGE
        );
      }
      if (wrongAmount.length > 0) {
        return new RunnerError(
          'TRANSFER_NOT_OBSERVED',
          TRANSFER_WRONG_AMOUNT_MESSAGE
        );
      }
      if (decoded.length > 0) {
        const moved = decoded[0]!;
        return new RunnerError(
          'TRANSFER_TOKEN_MISMATCH',
          TRANSFER_TOKEN_DISAGREEMENT_MESSAGE
        );
      }
      return new RunnerError(
        'TRANSFER_NOT_OBSERVED',
        TRANSFER_NO_LOG_MESSAGE
      );
    }
    return new RunnerError(
      'TRANSFER_MISMATCH',
      TRANSFER_AMBIGUOUS_MESSAGE
    );
  }

  private async finalizedHead(): Promise<CanonicalFinalizedBlock> {
    try {
      return await matchedFinalizedHeadHere(this.config.primary, this.config.secondary);
    } catch (error) {
      throw new RunnerError('RECEIPT_RPC_CONFLICT', FINALITY_MISMATCH);
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

/**
 * Turn a reader failure into a runner-authored error, classified only by its
 * sentinel.
 *
 * The readers are injected by the caller, so their errors are not this module's
 * text: a transport failure can carry an endpoint URL, an API key, or a request
 * body. The sentinel string is the only part that is safe to branch on, because
 * it is produced by `canonical-chain` rather than by the reader. The message is
 * one of two runner literals, chosen by that sentinel and nothing else.
 */
function readerFailure(error: unknown): RunnerError {
  return messageOf(error).includes('RPC_STATE_MISMATCH')
    ? new RunnerError('RECEIPT_RPC_CONFLICT', READERS_DISAGREE)
    : new RunnerError('JOB_READ_FAILED', READ_JOB_NOT_AVAILABLE);
}

/**
 * Turn a receipt or transfer reader failure into a runner-authored error.
 *
 * Same reasoning as `readerFailure`: the sentinel decides between "the two
 * readers conflict" and "this one transaction is not usable yet", and the
 * message is the runner's own literal rather than the reader's transport text.
 * The caller supplies the pair of codes and the not-yet-final message because
 * a task transfer and a submission receipt are different facts.
 */
function receiptFailure(
  error: unknown,
  conflict: RunFailureCode,
  pending: RunFailureCode,
  pendingMessage: string
): RunnerError {
  return messageOf(error).includes('MISMATCH')
    ? new RunnerError(conflict, FINALITY_MISMATCH)
    : new RunnerError(pending, pendingMessage);
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
