/** Browser-only, wallet-owned Monad Testnet transactions. No local signer or fake receipt. */

import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeFunctionData,
  http,
  keccak256,
  toBytes,
  BaseError,
  UserRejectedRequestError,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { monadTestnet } from 'viem/chains';
import { matchedFinalizedReceipt, viemPublicClientToCanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { validateConfig, type XYXConfig } from '../../../packages/monad/src/config';
import { validateProtocolConfig } from '../../../packages/monad/src/protocol';
import type { ContractRequest } from '../../../packages/monad/src/delivery-chain';
import type { Receipt } from '../../../packages/monad/src/chain-primitives';

type InjectedProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

function provider(): InjectedProvider {
  if (typeof window === 'undefined') throw new Error('WALLET_BROWSER_REQUIRED');
  const injected = (window as Window & { ethereum?: InjectedProvider }).ethereum;
  if (!injected || typeof injected.request !== 'function') throw new Error('INJECTED_WALLET_REQUIRED');
  return injected;
}

function publicClients(config: XYXConfig) {
  if (!config.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
  return {
    primary: createPublicClient({ chain: monadTestnet, transport: http(config.rpcUrl, { timeout: 15_000 }) }),
    secondary: createPublicClient({ chain: monadTestnet, transport: http(config.secondaryRpcUrl, { timeout: 15_000 }) }),
  };
}

export async function connectWallet(): Promise<Address> {
  const wallet = createWalletClient({ chain: monadTestnet, transport: custom(provider()) });
  const chainId = await wallet.getChainId();
  if (chainId !== monadTestnet.id) throw new Error('WALLET_WRONG_CHAIN');
  const [account] = await wallet.requestAddresses();
  if (!account) throw new Error('WALLET_ACCOUNT_MISSING');
  return account;
}

export type BrowserTransactionOutcome =
  | { status: 'pending'; hash: Hex }
  | { status: 'finalized'; hash: Hex; receipt: Receipt }
  | { status: 'reverted'; hash: Hex; receipt: Receipt };

export interface BrowserTransactionCallbacks {
  onWalletPrompt?: () => void;
  onSubmitted?: (hash: Hex) => void;
  onReceipt?: () => void;
}

type JournalRecord = { status: 'attempting' | 'submitted' | 'ambiguous' | 'finalized' | 'reverted'; hash?: Hex; dataDigest: Hex };

function journalKey(config: XYXConfig, account: Address, operationId: string): string {
  if (!/^[a-zA-Z0-9:.-]{1,128}$/.test(operationId)) throw new Error('OPERATION_ID_INVALID');
  return `xyx-operation-${keccak256(toBytes(`${config.chainId}:${config.protocolAddress.toLowerCase()}:${account.toLowerCase()}:${operationId}`))}`;
}

function readJournal(key: string): JournalRecord | null {
  try {
    const text = window.localStorage.getItem(key);
    if (text === null) return null;
    const value = JSON.parse(text) as JournalRecord;
    if (!['attempting', 'submitted', 'ambiguous', 'finalized', 'reverted'].includes(value.status) ||
        (value.hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(value.hash)) ||
        !/^0x[0-9a-fA-F]{64}$/.test(value.dataDigest)) throw new Error('OPERATION_JOURNAL_CORRUPT');
    return value;
  } catch (error) {
    if (error instanceof Error && error.message === 'OPERATION_JOURNAL_CORRUPT') throw error;
    throw new Error('OPERATION_JOURNAL_UNAVAILABLE');
  }
}

function writeJournal(key: string, record: JournalRecord): void {
  try { window.localStorage.setItem(key, JSON.stringify(record)); }
  catch { throw new Error('OPERATION_JOURNAL_UNAVAILABLE'); }
}

function clearJournal(key: string): void {
  try { window.localStorage.removeItem(key); }
  catch { throw new Error('OPERATION_JOURNAL_UNAVAILABLE'); }
}

function finalityConflict(code: string): boolean {
  return code === 'RPC_RECEIPT_MISMATCH' || code === 'RECEIPT_BLOCK_MISMATCH' || code.includes('WRONG_CHAIN') || code === 'RPC_TRANSACTION_MISMATCH';
}

function wasUserRejected(error: unknown): boolean {
  const matches = (value: unknown) => value instanceof UserRejectedRequestError ||
    (typeof value === 'object' && value !== null && 'code' in value && value.code === 4001);
  return matches(error) || (error instanceof BaseError && error.walk(matches) !== null);
}

export async function executeBrowserTransaction(
  config: XYXConfig,
  request: ContractRequest,
  operationId: string,
  callbacks: BrowserTransactionCallbacks = {},
): Promise<BrowserTransactionOutcome> {
  if (validateConfig(config).errors.length !== 0) throw new Error('CONFIG_INVALID');
  const deployment = await validateProtocolConfig(config);
  if (deployment.errors.length !== 0) throw new Error(`DEPLOYMENT_NOT_READY:${deployment.errors[0]}`);

  const account = await connectWallet();
  if (request.from && request.from.toLowerCase() !== account.toLowerCase()) throw new Error('WALLET_ROLE_MISMATCH');
  const { primary, secondary } = publicClients(config);
  const chainIds = await Promise.all([primary.getChainId(), secondary.getChainId()]);
  if (chainIds.some(id => id !== monadTestnet.id)) throw new Error('RPC_WRONG_CHAIN');
  const data = encodeFunctionData({ abi: request.abi as Abi, functionName: request.functionName, args: request.args });
  const dataDigest = keccak256(data);
  const key = journalKey(config, account, operationId);
  const primaryReader = viemPublicClientToCanonicalChainReader(primary);
  const secondaryReader = viemPublicClientToCanonicalChainReader(secondary);
  const observe = async (hash: Hex): Promise<{ status: 'finalized' | 'reverted'; hash: Hex; receipt: Receipt }> => {
    const [{ receipt }, firstTx, secondTx] = await Promise.all([
      matchedFinalizedReceipt(primaryReader, secondaryReader, hash),
      primaryReader.getTransaction({ hash }), secondaryReader.getTransaction({ hash }),
    ]);
    if (firstTx.hash.toLowerCase() !== hash.toLowerCase() || secondTx.hash.toLowerCase() !== hash.toLowerCase() ||
        firstTx.from.toLowerCase() !== account.toLowerCase() || secondTx.from.toLowerCase() !== account.toLowerCase() ||
        firstTx.to?.toLowerCase() !== request.address.toLowerCase() || secondTx.to?.toLowerCase() !== request.address.toLowerCase() ||
        firstTx.input.toLowerCase() !== data.toLowerCase() || secondTx.input.toLowerCase() !== data.toLowerCase()) {
      throw new Error('RPC_TRANSACTION_MISMATCH');
    }
    return { status: receipt.status === 'success' ? 'finalized' : 'reverted', hash, receipt };
  };
  const previous = readJournal(key);
  if (previous && previous.status !== 'reverted') {
    if (previous.dataDigest !== dataDigest) {
      if (previous.hash) callbacks.onSubmitted?.(previous.hash);
      throw new Error('OPERATION_PAYLOAD_CHANGED_RECONCILE_PREVIOUS');
    }
    if (!previous.hash) throw new Error('OPERATION_RECONCILIATION_REQUIRED');
    callbacks.onSubmitted?.(previous.hash);
    try {
      const result = await observe(previous.hash);
      writeJournal(key, { status: result.status, hash: previous.hash, dataDigest });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (finalityConflict(code)) throw new Error('RPC_FINALITY_CONFLICT');
      return { status: 'pending', hash: previous.hash };
    }
  }
  let estimate: bigint;
  try {
    estimate = await primary.estimateGas({ account, to: request.address, data });
  } catch {
    throw new Error('GAS_ESTIMATE_FAILED');
  }
  // Monad bills the gas limit, not gas used. Never let a wallet silently choose
  // an inflated fallback limit after an estimate fails; use at most 10% headroom.
  const gas = estimate + estimate / 10n;
  if (gas <= 0n || gas > 30_000_000n) throw new Error('GAS_LIMIT_UNSAFE');

  const wallet = createWalletClient({ chain: monadTestnet, transport: custom(provider()) });
  writeJournal(key, { status: 'attempting', dataDigest });
  callbacks.onWalletPrompt?.();
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account, to: request.address, data, gas, chain: monadTestnet });
  } catch (error) {
    if (wasUserRejected(error)) {
      clearJournal(key);
      throw new Error('USER_REJECTED');
    }
    // The wallet may have sent the transaction but lost its RPC response.
    // Never turn this into a retryable failure or invent a hash.
    writeJournal(key, { status: 'ambiguous', dataDigest });
    throw new Error('SUBMISSION_UNCERTAIN_RECONCILE_WALLET');
  }
  writeJournal(key, { status: 'submitted', hash, dataDigest });
  callbacks.onSubmitted?.(hash);

  try {
    await primary.waitForTransactionReceipt({ hash, timeout: 90_000 });
    callbacks.onReceipt?.();
  } catch {
    return { status: 'pending', hash };
  }

  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      const result = await observe(hash);
      writeJournal(key, { status: result.status, hash, dataDigest });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (finalityConflict(code)) {
        throw new Error('RPC_FINALITY_CONFLICT');
      }
      if (attempt < 44) await new Promise(resolve => setTimeout(resolve, 2_000));
    }
  }
  return { status: 'pending', hash };
}
