/**
 * Canonical provider-runner adapter interfaces (Monad Testnet).
 *
 * The provider runner is a state machine, not a wallet. It never reads a private
 * key from an environment variable, from disk, from an API request body, from
 * browser storage, or from a public server, because it has no way to hold one:
 * every signing side effect goes through {@link ProviderSigner}, which the
 * integrator injects. Nothing in this module, or in the runner that consumes it,
 * supplies a default implementation, a demo executor, or a synthetic success
 * path. If a signer is absent the runner cannot send a transaction, and it
 * reports that instead of inventing one.
 *
 * The narrowness is deliberate. A signer that could read arbitrary chain state
 * or build arbitrary calldata would let the runner be talked into signing
 * something other than the one canonical `submitDelivery` request it prepared
 * and validated, so the only thing a signer can do here is send a request the
 * runner has already checked and report the transaction hash that came back.
 *
 * @module @xyx/monad/provider-runner/adapters
 */

import type { Address, Hex } from 'viem';

import type { ContractRequest } from '../delivery-chain';

/**
 * A broadcast that has been **submitted but not proven mined**.
 *
 * This is the runner's most dangerous shape: a returned hash is not a receipt,
 * and a missing hash is not a proof of failure. Neither case may be resolved by
 * guessing, so both are represented explicitly and only a real finalized
 * two-RPC receipt can move a send out of {@link RunStatus.SUBMITTED}.
 */
export type ProviderSendOutcome =
  /** The signer returned a transaction hash. Nothing is yet known about inclusion or finality. */
  | { readonly kind: 'submitted'; readonly transactionHash: Hex }
  /** No hash came back. The transaction may or may not have reached the mempool. */
  | { readonly kind: 'ambiguous' }
  /** The signer refused or failed before broadcasting. No hash exists to reconcile. */
  | { readonly kind: 'rejected'; readonly reason: string }
  /** The user/integrator abandoned the action before it was signed. */
  | { readonly kind: 'cancelled' };

/**
 * The only signing capability the provider runner may use.
 *
 * Implementations are supplied by the integrator (a wallet connection, a
 * hardware signer, a relayer that an operator authorized out of band). A
 * provider runner MUST NOT construct, default, discover, or fall back to a
 * signer: `runner.run()` without one fails closed rather than degrading to a
 * simulated success.
 */
export interface ProviderSigner {
  /** The address that will sign. Must equal the observed on-chain job provider. */
  readonly address: Address;
  /** Broadcast the exact request the runner prepared. Must not alter it. */
  sendTransaction(request: ContractRequest): Promise<ProviderSendOutcome>;
}

/**
 * The result of one unit of real provider work.
 *
 * A {@link TaskExecutor} either returns a genuine structured delivery result or
 * an explicit failure. There is no third option on purpose: an executor that
 * cannot finish must say so, because a canned or always-succeeding executor is
 * indistinguishable from fabricated evidence and this runner may not
 * manufacture a delivery for a funded job.
 */
export type TaskExecutionResult =
  | { readonly ok: true; readonly delivery: UnknownRecord }
  | { readonly ok: false; readonly reason: string };

/** A structured, JSON-serializable object. Field values are untrusted input. */
export type UnknownRecord = Record<string, unknown>;

/**
 * Real work performed by the provider, whose output becomes the private
 * delivery payload that the delivery commitment binds.
 */
export interface TaskExecutor {
  /**
   * Execute the task for `job` using `input` and return the real result.
   *
   * `input` is the decrypted private delivery input, which is sensitive: an
   * executor may use it freely, and the runner will not serialize it.
   */
  execute(job: ProviderJobView, input: PrivateDeliveryMaterial): Promise<TaskExecutionResult>;
}

/** The public subset of a canonical job that an executor is allowed to see. */
export interface ProviderJobView {
  readonly jobId: bigint;
  readonly buyer: Address;
  readonly provider: Address;
  readonly attestor: Address;
  readonly termsCommitment: Hex;
  readonly budget: bigint;
  readonly expiresAt: bigint;
  readonly status: number;
}

/**
 * The private delivery material handed to the runner.
 *
 * The runner never returns it, never serializes it, and never places its
 * plaintext, salt, or executor output into `RunEvidence`, a `RunnerError`, or
 * any public output: it exists so those bytes can be hashed into a commitment
 * in memory and then dropped. The builder tests prove that.
 *
 * This interface does NOT make the object impossible to stringify. It is a
 * plain object, and an integrator who already holds it can always call
 * `JSON.stringify` on it. The guarantee is about what the runner does with the
 * material it is given, not about what a caller can do with its own object.
 */
export interface PrivateDeliveryMaterial {
  readonly schema: string;
  readonly kind: string;
  readonly content: UnknownRecord;
  /** 32-byte hex salt used to build the on-chain delivery commitment. */
  readonly salt: Hex;
}

/**
 * The private-input source for stage 2.
 *
 * The runner calls this once per run and immediately validates the returned
 * delivery material against the on-chain job before any executor sees it.
 */
export interface PrivateInputProvider {
  /**
   * Return the private delivery material for `jobId`.
   *
   * Implementations decrypt an injected handoff result or read an operator-held
   * bundle. They must never read a private key, and the material they return
   * stays in the runner's memory.
   */
  provide(job: ProviderJobView): Promise<PrivateDeliveryMaterial>;
}

/**
 * The required on-chain "task transfer" that a provider performs as part of the
 * work itself, separate from the protocol call.
 *
 * This is the ERC-20 transfer the private terms require (for example, paying a
 * downstream contributor). It is real: the runner must observe a finalized
 * two-RPC receipt for it and bind it into the delivery commitment, and it may
 * never be represented as done without one.
 */
export interface TaskTransferRequirement {
  /** The ERC-20 token that must move. Must equal the protocol payment token. */
  readonly token: Address;
  /** The exact transfer recipient required by the terms. */
  readonly recipient: Address;
  /** The exact atomic amount required by the terms. */
  readonly amountAtomic: bigint;
  /**
   * An already-observed transfer transaction hash, when the integrator performed
   * the transfer through their own wallet and is handing the runner proof to
   * verify rather than asking the runner to send it.
   *
   * @deprecated Prefer {@link TaskTransferPlan.observedTransactionHash}. A proof
   * of a transfer is not part of the terms that require it, so an integrator
   * that keeps them together has to nest a claim about what already happened
   * inside a description of what must happen. Both spellings are honoured, and
   * setting both to different hashes is rejected.
   */
  readonly observedTransactionHash?: Hex;
}
