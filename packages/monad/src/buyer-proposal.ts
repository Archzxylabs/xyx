/**
 * Buyer proposal preparation (Monad Testnet) — a request builder, not a broadcaster.
 *
 * A buyer browser can construct private terms, hash them into a commitment, and
 * build the exact `proposeJob` request those terms bind. That is the end of what
 * the reference builder does. It does not broadcast, so it cannot produce a
 * transaction hash, a receipt, a block number, gas, finality, or a job ID, and it
 * must not invent any of them: a locally signed bundle that was never sent is not
 * evidence of anything on-chain.
 *
 * Everything a caller may show the buyer therefore has to come through
 * {@link prepareBuyerProposal}, whose result is exactly the commitment and the
 * request — nothing shaped like chain evidence. Whether escrow funding may be
 * offered is decided by {@link canOfferFunding}, which only an actually observed
 * job ID can satisfy; nothing computed locally can unlock it.
 *
 * @module @xyx/monad/buyer-proposal
 */

import type { Address, Hex } from 'viem';

import { createTermsCommitment, privateTermsSchema, type PrivateTermsInput } from './delivery';
import {
  buildProposalRequest,
  type ContractAddresses,
  type ContractRequest,
} from './delivery-chain';

/**
 * The label every prepared request must carry.
 *
 * Preparation is a real local computation, not a simulated transaction.
 * The label still states clearly that no on-chain action happened.
 */
export const PREPARED_NOT_BROADCAST_LABEL = 'REQUEST PREPARED — NOT BROADCAST';

/** Why the escrow-funding action is unavailable to the reference builder. */
export const FUNDING_UNAVAILABLE_REASON =
  'FUNDING_UNAVAILABLE: escrow funding needs a job ID observed from a real broadcast and a finalized receipt. Preparing a request produces neither.';

/** What the buyer is allowed to see: the commitment and the request it binds. */
export interface PreparedProposal {
  termsCommitment: Hex;
  request: ContractRequest;
}

export interface PreparedProposalInput {
  terms: PrivateTermsInput;
  salt: Hex;
  addresses: ContractAddresses;
}

/**
 * Validate terms, hash them into a commitment, and build the proposal request.
 *
 * The returned value carries no `hash`, `receipt`, `blockNumber`, `gasUsed`,
 * `finalized`, or `jobId` field by construction — a caller has nothing to present
 * as a chain fact.
 *
 * @throws on invalid terms or an unusable request (zero addresses, non-positive
 *   budget, an expiry in the past, a zero commitment)
 */
export function prepareBuyerProposal(input: PreparedProposalInput): PreparedProposal {
  const parsed = privateTermsSchema.parse(input.terms);
  const { commitment } = createTermsCommitment(parsed, input.salt);
  const request = buildProposalRequest(
    {
      provider: parsed.provider as Address,
      attestor: parsed.attestor as Address,
      budget: BigInt(parsed.budgetAtomic),
      termsCommitment: commitment,
      expiresAt: BigInt(parsed.expiresAt),
    },
    input.addresses,
  );
  return { termsCommitment: commitment, request };
}

/**
 * Whether escrow funding may be offered.
 *
 * Only a job ID observed from a real broadcast and a finalized receipt counts —
 * the protocol assigns job IDs in `proposeJob`, so no local value is one. The
 * reference builder never obtains such an ID, so it never gets `true` here.
 */
export function canOfferFunding(observedJobId: bigint | null | undefined): boolean {
  return typeof observedJobId === 'bigint' && observedJobId > 0n;
}
