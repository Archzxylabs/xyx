/**
 * ERC-20 `Transfer` event fixtures.
 *
 * These build real ABI-encoded event data and topics, so the runner's decode
 * path is exercised exactly as it runs against a live RPC. Two hazards are
 * worth naming because getting them wrong produces a fixture that silently
 * proves nothing:
 *
 *   1. `Transfer` indexes only `from` and `to`. `value` is non-indexed, so the
 *      event has exactly TWO topics and the amount travels in `data`. Passing a
 *      third topic, or putting the amount in a topic, makes `decodeEventLog`
 *      with `strict: true` reject the log outright.
 *   2. Event `data` is abi-encoded event arguments, NOT function calldata.
 *      `encodeFunctionData` produces calldata for `transfer(address,uint256)`,
 *      which is a different byte layout and does not decode as an event.
 *
 * A fixture built wrongly does not fail loudly: `tokenTransfers` swallows the
 * decode error and returns no rows, so the test would see a misleading
 * `TRANSFER_NOT_OBSERVED` instead of the case it was trying to construct.
 */

import type { Hex } from 'viem';
import { encodeEventTopics, encodeAbiParameters, type Address } from 'viem';

/** Minimal ERC-20 Transfer ABI matching the canonical decoder in chain-primitives. */
const TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

export interface TransferLogFixture {
  readonly address: Address;
  readonly data: Hex;
  readonly topics: readonly [Hex, ...Hex[]];
}

/**
 * A genuine `Transfer` log from `token` moving `value` from `from` to `to`.
 */
export function transferLog(
  token: Address,
  from: Address,
  to: Address,
  value: bigint
): TransferLogFixture {
  // viem returns [signature, from, to] for a 2-indexed-param event. That is the
  // canonical topics array as a live RPC would return it, so it is used as-is;
  // reordering here would produce a log the real decoder rejects.
  const topics = encodeEventTopics({
    abi: [TRANSFER_EVENT],
    eventName: 'Transfer',
    args: { from, to, value },
  });
  if (topics.length !== 3) {
    throw new Error(`Transfer event must encode 3 topics (signature + 2 indexed), got ${topics.length}`);
  }
  return {
    address: token,
    // abi.encode(uint256) — the non-indexed amount as event data.
    data: encodeAbiParameters([{ type: 'uint256' }], [value]),
    topics: topics as readonly [Hex, ...Hex[]],
  };
}
