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
  type PublicClient,
} from 'viem';
import { monadTestnet } from 'viem/chains';
import { matchedFinalizedReceipt, viemPublicClientToCanonicalChainReader, type CanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import { validateConfig, type XYXConfig } from '../../../packages/monad/src/config';
import { validateProtocolConfig } from '../../../packages/monad/src/protocol';
import type { ContractRequest } from '../../../packages/monad/src/delivery-chain';
import type { Receipt } from '../../../packages/monad/src/chain-primitives';

export type InjectedProvider = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };

function provider(customProvider?: InjectedProvider): InjectedProvider {
  if (customProvider) return customProvider;
  const globalObj = typeof window !== 'undefined'
    ? window
    : (globalThis as unknown as { window?: { ethereum?: InjectedProvider }; ethereum?: InjectedProvider });
  const injected = (globalObj as { ethereum?: InjectedProvider }).ethereum ??
    (globalObj as { window?: { ethereum?: InjectedProvider } })?.window?.ethereum;
  if (!injected || typeof injected.request !== 'function') throw new Error('INJECTED_WALLET_REQUIRED');
  return injected;
}

function publicClients(config: XYXConfig): { primary: PublicClient; secondary: PublicClient } {
  if (!config.secondaryRpcUrl) throw new Error('SECONDARY_RPC_URL_MISSING');
  return {
    primary: createPublicClient({ chain: monadTestnet, transport: http(config.rpcUrl, { timeout: 15_000 }) }) as PublicClient,
    secondary: createPublicClient({ chain: monadTestnet, transport: http(config.secondaryRpcUrl, { timeout: 15_000 }) }) as PublicClient,
  };
}

export async function connectWallet(customProvider?: InjectedProvider): Promise<Address> {
  const wallet = createWalletClient({ chain: monadTestnet, transport: custom(provider(customProvider)) });
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
  injectedProvider?: InjectedProvider;
  primaryClient?: PublicClient;
  secondaryClient?: PublicClient;
  primaryReader?: CanonicalChainReader;
  secondaryReader?: CanonicalChainReader;
  skipDeploymentCheck?: boolean;
  skipServerSync?: boolean;
  maxObserveAttempts?: number;
  observeDelayMs?: number;
}

export interface JournalRecord {
  readonly status: 'attempting' | 'submitted' | 'ambiguous' | 'finalized' | 'reverted';
  readonly hash?: Hex;
  readonly dataDigest: Hex;
  readonly serverOpId?: string;
  readonly capabilityToken?: string;
}

function getStorage(): Storage {
  const globalObj = typeof window !== 'undefined'
    ? window
    : (globalThis as unknown as { window?: { localStorage?: Storage }; localStorage?: Storage });
  const storage = (globalObj as { localStorage?: Storage }).localStorage ??
    (globalObj as { window?: { localStorage?: Storage } })?.window?.localStorage;
  if (!storage) throw new Error('OPERATION_JOURNAL_UNAVAILABLE');
  return storage;
}

export function journalKey(config: XYXConfig, account: Address, operationId: string): string {
  if (!/^[a-zA-Z0-9:.-]{1,128}$/.test(operationId)) throw new Error('OPERATION_ID_INVALID');
  return `xyx-operation-${keccak256(toBytes(`${config.chainId}:${config.protocolAddress.toLowerCase()}:${account.toLowerCase()}:${operationId}`))}`;
}

export function readJournal(key: string): JournalRecord | null {
  try {
    const text = getStorage().getItem(key);
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

export function writeJournal(key: string, record: JournalRecord): void {
  try { getStorage().setItem(key, JSON.stringify(record)); }
  catch { throw new Error('OPERATION_JOURNAL_UNAVAILABLE'); }
}

export function clearJournal(key: string): void {
  try { getStorage().removeItem(key); }
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

export interface ServerOperationSyncSession {
  readonly serverOpId: string;
  readonly capabilityToken: string;
}

export async function createServerOperation(
  config: XYXConfig,
  account: Address,
  operationId: string,
  dataDigest: Hex,
  request: ContractRequest,
): Promise<ServerOperationSyncSession | null> {
  if (typeof fetch === 'undefined') return null;
  const kindMap: Record<string, string> = {
    proposeJob: 'PROPOSE_JOB',
    acceptJob: 'ACCEPT_JOB',
    fundJob: 'FUND_JOB',
    submitDelivery: 'SUBMIT_DELIVERY',
    resolveJob: 'RESOLVE_JOB',
    cancelProposal: 'CANCEL_PROPOSAL',
    claimExpiryRefund: 'CLAIM_EXPIRY_REFUND',
  };
  const kind = kindMap[request.functionName];
  if (!kind) return null;
  const role = (kind === 'PROPOSE_JOB' || kind === 'FUND_JOB' || kind === 'CANCEL_PROPOSAL')
    ? 'buyer'
    : (kind === 'ACCEPT_JOB' || kind === 'SUBMIT_DELIVERY')
    ? 'provider'
    : (kind === 'RESOLVE_JOB')
    ? 'attestor'
    : 'buyer';
  const maybeJobId = (request.args && typeof request.args[0] === 'bigint') ? Number(request.args[0]) : null;

  try {
    const res = await fetch('/api/operations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        idempotencyKey: operationId,
        kind,
        actor: account,
        actorRole: role,
        expectedChainId: config.chainId,
        deployment: {
          protocol: config.protocolAddress,
          paymentToken: config.paymentTokenAddress ?? config.protocolAddress,
          registry: config.registryAddress,
          verifier: config.p256VerifierAddress,
        },
        intentDigest: dataDigest,
        jobId: maybeJobId,
      }),
    });
    if (res.status === 409) {
      throw new Error('IDEMPOTENCY_KEY_CONFLICT');
    }
    if (!res.ok) {
      throw new Error('SERVER_OPERATION_JOURNAL_UNAVAILABLE');
    }
    const data = await res.json() as { id: string; capabilityToken?: string };
    if (!data.id) {
      throw new Error('SERVER_OPERATION_JOURNAL_UNAVAILABLE');
    }
    return {
      serverOpId: data.id,
      capabilityToken: data.capabilityToken ?? '',
    };
  } catch (error) {
    if (error instanceof Error && (error.message === 'IDEMPOTENCY_KEY_CONFLICT' || error.message === 'SERVER_OPERATION_JOURNAL_UNAVAILABLE')) {
      throw error;
    }
    throw new Error('SERVER_OPERATION_JOURNAL_UNAVAILABLE');
  }
}

export async function patchServerOperation(
  session: ServerOperationSyncSession | null | undefined,
  body: Record<string, unknown>,
): Promise<any> {
  if (!session || typeof fetch === 'undefined') return null;
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (session.capabilityToken) {
      headers['x-operation-capability'] = session.capabilityToken;
    }
    const res = await fetch(`/api/operations/${encodeURIComponent(session.serverOpId)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return await res.json().catch(() => ({}));
    }
    return await res.json();
  } catch {
    return null;
  }
}

export async function executeBrowserTransaction(
  config: XYXConfig,
  request: ContractRequest,
  operationId: string,
  callbacks: BrowserTransactionCallbacks = {},
): Promise<BrowserTransactionOutcome> {
  if (validateConfig(config).errors.length !== 0) throw new Error('CONFIG_INVALID');
  if (!callbacks.skipDeploymentCheck) {
    const deployment = await validateProtocolConfig(config);
    if (deployment.errors.length !== 0) throw new Error(`DEPLOYMENT_NOT_READY:${deployment.errors[0]}`);
  }

  const account = await connectWallet(callbacks.injectedProvider);
  if (request.from && request.from.toLowerCase() !== account.toLowerCase()) throw new Error('WALLET_ROLE_MISMATCH');
  const { primary, secondary } = callbacks.primaryClient && callbacks.secondaryClient
    ? { primary: callbacks.primaryClient, secondary: callbacks.secondaryClient }
    : publicClients(config);
  const chainIds = await Promise.all([primary.getChainId(), secondary.getChainId()]);
  if (chainIds.some(id => id !== monadTestnet.id)) throw new Error('RPC_WRONG_CHAIN');
  const data = encodeFunctionData({ abi: request.abi as Abi, functionName: request.functionName, args: request.args });
  const dataDigest = keccak256(data);
  const key = journalKey(config, account, operationId);
  const primaryReader = callbacks.primaryReader ?? viemPublicClientToCanonicalChainReader(primary);
  const secondaryReader = callbacks.secondaryReader ?? viemPublicClientToCanonicalChainReader(secondary);
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
  let session: ServerOperationSyncSession | null = null;
  const previous = readJournal(key);
  if (previous && previous.status !== 'reverted') {
    if (previous.dataDigest !== dataDigest) {
      if (previous.hash) callbacks.onSubmitted?.(previous.hash);
      throw new Error('OPERATION_PAYLOAD_CHANGED_RECONCILE_PREVIOUS');
    }
    if (!previous.hash) throw new Error('OPERATION_RECONCILIATION_REQUIRED');
    callbacks.onSubmitted?.(previous.hash);
    if (previous.serverOpId) {
      session = { serverOpId: previous.serverOpId, capabilityToken: previous.capabilityToken ?? '' };
    }
    try {
      const result = await observe(previous.hash);
      if (session) {
        await patchServerOperation(session, {
          action: 'ADD_OBSERVATION',
          observation: {
            source: 'primary',
            rpc: 'primary-rpc',
            blockNumber: Number(result.receipt.blockNumber),
            blockHash: result.receipt.blockHash,
            status: result.receipt.status === 'success' ? 'success' : 'reverted',
          },
        });
        await patchServerOperation(session, {
          action: 'ADD_OBSERVATION',
          observation: {
            source: 'secondary',
            rpc: 'secondary-rpc',
            blockNumber: Number(result.receipt.blockNumber),
            blockHash: result.receipt.blockHash,
            status: result.receipt.status === 'success' ? 'success' : 'reverted',
          },
        });
        const reconciled = await patchServerOperation(session, { action: 'RECONCILE' });
        if (reconciled?.reconciliation === 'AGREED' && result.status === 'finalized') {
          await patchServerOperation(session, { action: 'TRANSITION', to: 'FINALIZED' });
        }
      }
      writeJournal(key, {
        status: result.status,
        hash: previous.hash,
        dataDigest,
        serverOpId: session?.serverOpId,
        capabilityToken: session?.capabilityToken,
      });
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

  if (!callbacks.skipServerSync) {
    session = await createServerOperation(config, account, operationId, dataDigest, request);
  }
  const wallet = createWalletClient({ chain: monadTestnet, transport: custom(provider(callbacks.injectedProvider)) });
  writeJournal(key, {
    status: 'attempting',
    dataDigest,
    serverOpId: session?.serverOpId,
    capabilityToken: session?.capabilityToken,
  });
  callbacks.onWalletPrompt?.();
  let hash: Hex;
  try {
    hash = await wallet.sendTransaction({ account, to: request.address, data, gas, chain: monadTestnet });
  } catch (error) {
    if (wasUserRejected(error)) {
      clearJournal(key);
      if (session) {
        await patchServerOperation(session, {
          action: 'FAIL',
          code: 'USER_REJECTED',
          diagnostic: 'User rejected in wallet',
        });
      }
      throw new Error('USER_REJECTED');
    }
    // The wallet may have sent the transaction but lost its RPC response.
    // Never turn this into a retryable failure or invent a hash.
    writeJournal(key, {
      status: 'ambiguous',
      dataDigest,
      serverOpId: session?.serverOpId,
      capabilityToken: session?.capabilityToken,
    });
    if (session) {
      await patchServerOperation(session, {
        action: 'TRANSITION',
        to: 'AMBIGUOUS',
        detail: { diagnostic: 'WALLET_SUBMISSION_UNCERTAIN' },
      });
    }
    throw new Error('SUBMISSION_UNCERTAIN_RECONCILE_WALLET');
  }
  writeJournal(key, {
    status: 'submitted',
    hash,
    dataDigest,
    serverOpId: session?.serverOpId,
    capabilityToken: session?.capabilityToken,
  });
  if (session) {
    await patchServerOperation(session, { action: 'RECORD_HASH', transactionHash: hash });
  }
  callbacks.onSubmitted?.(hash);

  try {
    await primary.waitForTransactionReceipt({ hash, timeout: 90_000 });
    callbacks.onReceipt?.();
  } catch {
    return { status: 'pending', hash };
  }

  const maxAttempts = callbacks.maxObserveAttempts ?? 45;
  const delayMs = callbacks.observeDelayMs ?? 2_000;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await observe(hash);
      if (session) {
        await patchServerOperation(session, {
          action: 'ADD_OBSERVATION',
          observation: {
            source: 'primary',
            rpc: 'primary-rpc',
            blockNumber: Number(result.receipt.blockNumber),
            blockHash: result.receipt.blockHash,
            status: result.receipt.status === 'success' ? 'success' : 'reverted',
          },
        });
        await patchServerOperation(session, {
          action: 'ADD_OBSERVATION',
          observation: {
            source: 'secondary',
            rpc: 'secondary-rpc',
            blockNumber: Number(result.receipt.blockNumber),
            blockHash: result.receipt.blockHash,
            status: result.receipt.status === 'success' ? 'success' : 'reverted',
          },
        });
        const reconciled = await patchServerOperation(session, { action: 'RECONCILE' });
        if (reconciled?.reconciliation === 'AGREED' && result.status === 'finalized') {
          await patchServerOperation(session, { action: 'TRANSITION', to: 'FINALIZED' });
        } else if (reconciled?.reconciliation === 'DISAGREED') {
          await patchServerOperation(session, {
            action: 'FAIL',
            code: 'RECONCILIATION_CONFLICT',
            diagnostic: 'RPC observations disagreed',
          });
          writeJournal(key, {
            status: 'reverted',
            hash,
            dataDigest,
            serverOpId: session?.serverOpId,
            capabilityToken: session?.capabilityToken,
          });
          throw new Error('RPC_FINALITY_CONFLICT');
        }
      }
      writeJournal(key, {
        status: result.status,
        hash,
        dataDigest,
        serverOpId: session?.serverOpId,
        capabilityToken: session?.capabilityToken,
      });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (finalityConflict(code)) {
        if (session) {
          await patchServerOperation(session, {
            action: 'FAIL',
            code: 'RECONCILIATION_CONFLICT',
            diagnostic: code,
          });
        }
        throw new Error('RPC_FINALITY_CONFLICT');
      }
      if (attempt < maxAttempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return { status: 'pending', hash };
}
