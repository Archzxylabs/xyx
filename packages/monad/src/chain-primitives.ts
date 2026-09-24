/**
 * Neutral chain primitives for XYX Monad.
 *
 * Generic RPC receipt, transaction, finality, and address helpers shared by
 * both the legacy payout module and the canonical settlement modules.
 * No legacy contract ABI/event dependency.
 *
 * @module @xyx/monad/chain-primitives
 */

import type { Address, Hex } from 'viem';
import { decodeEventLog, encodeFunctionData, erc20Abi } from 'viem';

export type Transaction = {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  blockNumber: bigint | null;
  blockHash: Hex | null;
};

export type TransferLog = {
  address: Address;
  data: Hex;
  topics: readonly Hex[];
};

export type Receipt = {
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  status: 'success' | 'reverted';
  to: Address | null;
  logs: readonly TransferLog[];
};

export type ReceiptReader = {
  getChainId(): Promise<number>;
  getTransaction(args: { hash: Hex }): Promise<Transaction>;
  getTransactionReceipt(args: { hash: Hex }): Promise<Receipt>;
  getBlock(args: { blockNumber: bigint } | { blockTag: 'finalized' }): Promise<{
    number: bigint | null;
    hash: Hex | null;
    timestamp: bigint;
  }>;
};

export function sameAddress(a: string | null | undefined, b: string): boolean {
  return a?.toLowerCase() === b.toLowerCase();
}

/** Compare two 32-byte values for equality, ignoring case. */
export function sameHex(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function tokenTransfers(logs: readonly TransferLog[], token: string) {
  return logs.flatMap(log => {
    if (!sameAddress(log.address, token)) return [];
    try {
      const decoded = decodeEventLog({
        abi: erc20Abi,
        eventName: 'Transfer',
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      return [{ from: decoded.args.from, to: decoded.args.to, value: decoded.args.value.toString() }];
    } catch {
      return [];
    }
  });
}

export async function finalizedReceipt(reader: ReceiptReader, hash: Hex) {
  const receipt = await reader.getTransactionReceipt({ hash });
  const [block, finalized] = await Promise.all([
    reader.getBlock({ blockNumber: receipt.blockNumber }),
    reader.getBlock({ blockTag: 'finalized' }),
  ]);
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase() || block.number !== receipt.blockNumber
    || block.hash !== receipt.blockHash) throw new Error('RECEIPT_BLOCK_MISMATCH');
  if (finalized.number === null || finalized.number < receipt.blockNumber) throw new Error('RECEIPT_NOT_FINALIZED');
  return { receipt, block };
}

export function encodeErc20Transfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
}
