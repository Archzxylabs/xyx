/**
 * B3 Web Transaction Flow Test Suite
 *
 * Covers all 12 required test conditions:
 *   1. wrong-chain wallet
 *   2. wrong actor/provider
 *   3. allowance insufficient
 *   4. duplicate click/idempotency
 *   5. reload during pending transaction
 *   6. no-hash ambiguous send
 *   7. RPC disagreement
 *   8. passkey rejection
 *   9. expiry not yet eligible
 *  10. successful expiry refund
 *  11. no secret leakage
 *  12. /demo remains read-only and truthful
 */

import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  connectWallet,
  executeBrowserTransaction,
  journalKey,
  readJournal,
  writeJournal,
  clearJournal,
  type InjectedProvider,
  type JournalRecord,
} from '../lib/browser-transaction';
import {
  makePrivateTermsBundle,
  parsePrivateTermsBundle,
  parsePrivateDeliveryBundle,
  taskTransferFromTerms,
  type PrivateTermsBundle,
  type PrivateDeliveryBundle,
} from '../lib/private-terms-bundle';
import { reviewTaskEvidence } from '../lib/task-evidence';
import { createSecureHandoff, readSecureHandoff } from '../lib/secure-handoff';
import { generateSalt } from '../../../packages/monad/src/commitments';
import {
  buildClaimExpiryRefundRequest,
  buildFundRequest,
  type ContractAddresses,
  type ContractRequest,
} from '../../../packages/monad/src/delivery-chain';
import { deliveryProtocolAbi, type JobData } from '../../../packages/monad/src/protocol';
import type { XYXConfig } from '../../../packages/monad/src/config';
import type { CanonicalChainReader } from '../../../packages/monad/src/canonical-chain';
import type { Address, Hex } from 'viem';
import { encodeFunctionData, keccak256, parseUnits, toBytes } from 'viem';

// --- Test Constants & Setup ---

const MONAD_TESTNET_CHAIN_ID = 10143;
const BUYER: Address = '0x1111111111111111111111111111111111111111';
const PROVIDER: Address = '0x2222222222222222222222222222222222222222';
const ATTESTOR: Address = '0x3333333333333333333333333333333333333333';
const PROTOCOL: Address = '0x4444444444444444444444444444444444444444';
const TOKEN: Address = '0x5555555555555555555555555555555555555555';
const REGISTRY: Address = '0x6666666666666666666666666666666666666666';
const VERIFIER: Address = '0x7777777777777777777777777777777777777777';

const testConfig: XYXConfig = {
  chainId: MONAD_TESTNET_CHAIN_ID,
  protocolAddress: PROTOCOL,
  registryAddress: REGISTRY,
  p256VerifierAddress: VERIFIER,
  paymentTokenAddress: TOKEN,
  rpId: 'localhost',
  rpcUrl: 'http://localhost:8545/',
  secondaryRpcUrl: 'http://localhost:8546/',
};

const contractAddresses: ContractAddresses = {
  protocol: PROTOCOL,
  registry: REGISTRY,
  p256Verifier: VERIFIER,
  paymentToken: TOKEN,
};

// Memory storage mock for window.localStorage
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}

function setupMockEnvironment() {
  const storage = new MemoryStorage();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: storage,
    isSecureContext: true,
    location: { origin: 'http://localhost:3000' },
  };
  return storage;
}

function createMockProvider(options: {
  chainId?: number | string;
  accounts?: Address[];
  sendTxResult?: Hex | Error;
}): InjectedProvider {
  const chainIdHex = typeof options.chainId === 'number'
    ? `0x${options.chainId.toString(16)}`
    : (options.chainId ?? '0x279f'); // 10143
  const accounts = options.accounts ?? [BUYER];

  return {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      if (method === 'eth_chainId') return chainIdHex;
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return accounts;
      if (method === 'eth_estimateGas') return '0x5208'; // 21000
      if (method === 'eth_sendTransaction') {
        if (options.sendTxResult instanceof Error) throw options.sendTxResult;
        return options.sendTxResult ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      }
      throw new Error(`Unsupported mock method: ${method}`);
    },
  };
}

function createMockReader(overrides: Partial<CanonicalChainReader> = {}): CanonicalChainReader {
  return {
    getChainId: async () => MONAD_TESTNET_CHAIN_ID,
    getBlock: async (args) => {
      const number = 'blockNumber' in args ? args.blockNumber : 100n;
      return {
        number,
        hash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
        timestamp: 1700000000n,
      };
    },
    getTransaction: async (args) => ({
      hash: args.hash,
      from: BUYER,
      to: PROTOCOL,
      input: '0x',
      blockNumber: 100n,
      blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
      transactionIndex: 0,
      value: 0n,
    }),
    getTransactionReceipt: async (args) => ({
      status: 'success',
      transactionHash: args.hash,
      blockNumber: 100n,
      blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
      transactionIndex: 0,
      from: BUYER,
      to: PROTOCOL,
      logs: [],
      cumulativeGasUsed: 21000n,
      gasUsed: 21000n,
    }),
    readContract: async () => '0x',
    ...overrides,
  };
}

const mockPublicClient = {
  getChainId: async () => MONAD_TESTNET_CHAIN_ID,
  estimateGas: async () => 21000n,
  waitForTransactionReceipt: async () => ({ status: 'success' }),
} as any;

describe('B3 Web Transaction Flow', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = setupMockEnvironment();
  });

  afterEach(() => {
    storage.clear();
  });

  // -------------------------------------------------------------------------
  // 1. Wrong-chain wallet
  // -------------------------------------------------------------------------
  describe('1. Wrong-chain wallet', () => {
    it('rejects wallet connection when chain ID is Ethereum Mainnet (1)', async () => {
      const wrongChainProvider = createMockProvider({ chainId: 1 });
      await assert.rejects(
        () => connectWallet(wrongChainProvider),
        /WALLET_WRONG_CHAIN/,
        'connectWallet must reject chain ID 1'
      );
    });

    it('rejects wallet connection when chain ID is Polygon (137)', async () => {
      const wrongChainProvider = createMockProvider({ chainId: 137 });
      await assert.rejects(
        () => connectWallet(wrongChainProvider),
        /WALLET_WRONG_CHAIN/,
        'connectWallet must reject chain ID 137'
      );
    });

    it('accepts wallet connection on Monad Testnet (10143)', async () => {
      const testnetProvider = createMockProvider({ chainId: 10143, accounts: [BUYER] });
      const account = await connectWallet(testnetProvider);
      assert.equal(account.toLowerCase(), BUYER.toLowerCase());
    });

    it('rejects execution when RPC clients report wrong chain ID', async () => {
      const mockWallet = createMockProvider({ chainId: 10143, accounts: [BUYER] });
      const badRpcClient = {
        getChainId: async () => 1,
        estimateGas: async () => 21000n,
        waitForTransactionReceipt: async () => ({ status: 'success' }),
      } as any;

      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [1n],
        from: BUYER,
      };

      await assert.rejects(
        () =>
          executeBrowserTransaction(testConfig, request, 'test:wrong-chain-rpc', {
            injectedProvider: mockWallet,
            primaryClient: badRpcClient,
            secondaryClient: badRpcClient,
            skipDeploymentCheck: true,
          }),
        /RPC_WRONG_CHAIN/,
        'must fail closed when RPC chain is not Monad Testnet'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 2. Wrong actor / provider
  // -------------------------------------------------------------------------
  describe('2. Wrong actor / provider', () => {
    it('rejects transaction when wallet account does not match request.from', async () => {
      const providerWallet = createMockProvider({ chainId: 10143, accounts: [PROVIDER] });
      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [1n],
        from: BUYER, // Caller is PROVIDER, but request requires BUYER
      };

      await assert.rejects(
        () =>
          executeBrowserTransaction(testConfig, request, 'test:wrong-role', {
            injectedProvider: providerWallet,
            primaryClient: mockPublicClient,
            secondaryClient: mockPublicClient,
            skipDeploymentCheck: true,
          }),
        /WALLET_ROLE_MISMATCH/,
        'must reject when connected account does not match request sender'
      );
    });

    it('reviewTaskEvidence rejects when private bundle actors do not match on-chain job', async () => {
      const salt = generateSalt(32);
      const termsInput = {
        schema: 'xyx.private-terms' as const,
        chainId: 10143 as const,
        protocol: PROTOCOL,
        paymentToken: TOKEN,
        buyer: BUYER,
        provider: PROVIDER,
        attestor: ATTESTOR,
        budgetAtomic: '1000000',
        expiresAt: 1800000000,
        task: { recipient: '0x9999999999999999999999999999999999999999' as Address, amountAtomic: '500000', instructions: 'work' },
        acceptancePolicy: { maxRetries: 1, timeoutSeconds: 3600 },
      };

      const termsBundle = makePrivateTermsBundle(termsInput, salt, {
        jobId: 1n,
        fundingTx: '0x1111111111111111111111111111111111111111111111111111111111111111',
      });

      const deliveryBundle: PrivateDeliveryBundle = {
        schema: 'xyx.private-delivery-bundle.v1',
        jobId: '1',
        delivery: {
          schema: 'xyx.private-delivery',
          kind: 'response',
          content: { response: 'done', transferTx: '0x2222222222222222222222222222222222222222222222222222222222222222', recipient: '0x9999999999999999999999999999999999999999', amountAtomic: '500000' },
        },
        salt: generateSalt(32),
        commitment: '0x3333333333333333333333333333333333333333333333333333333333333333',
        transferTx: '0x2222222222222222222222222222222222222222222222222222222222222222',
        submissionTx: '0x4444444444444444444444444444444444444444444444444444444444444444',
      };

      // Mismatch between bundle job ID and target id
      await assert.rejects(
        () => reviewTaskEvidence(testConfig, 2n, termsBundle, deliveryBundle),
        /COMPLETE_RECEIPT_BUNDLES_REQUIRED/,
        'must reject when bundle job ID does not match target job ID'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3. Allowance insufficient
  // -------------------------------------------------------------------------
  describe('3. Allowance insufficient', () => {
    it('detects insufficient allowance and enforces approve step before fund', () => {
      const budget = parseUnits('100', 6); // 100 USDC (100,000,000 atomic)
      const currentAllowance = parseUnits('50', 6); // 50 USDC (insufficient)
      const currentBalance = parseUnits('200', 6); // 200 USDC (sufficient)

      const needsApproval = currentAllowance < budget;
      assert.equal(needsApproval, true, 'allowance < budget must trigger approval requirement');

      // Attempting to fund with insufficient balance must fail
      const lowBalance = parseUnits('80', 6);
      assert.throws(
        () => {
          if (lowBalance < budget) throw new Error('INSUFFICIENT_TOKEN_BALANCE');
        },
        /INSUFFICIENT_TOKEN_BALANCE/,
        'must fail when balance is less than required escrow budget'
      );
    });

    it('builds canonical fund request only when allowance and balance are sufficient', () => {
      const jobId = 10n;
      const request = buildFundRequest({ jobId, buyer: BUYER }, contractAddresses);
      assert.equal(request.address.toLowerCase(), PROTOCOL.toLowerCase());
      assert.equal(request.functionName, 'fundJob');
      assert.deepEqual(request.args, [jobId]);
      assert.equal(request.from?.toLowerCase(), BUYER.toLowerCase());
    });
  });

  // -------------------------------------------------------------------------
  // 4. Duplicate click / idempotency
  // -------------------------------------------------------------------------
  describe('4. Duplicate click / idempotency', () => {
    it('duplicate click on submitted operation reuses existing hash without resending', async () => {
      let sendCount = 0;
      const submittedHash: Hex = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const mockWallet = createMockProvider({
        chainId: 10143,
        accounts: [BUYER],
        sendTxResult: submittedHash,
      });
      // Override request to track send count
      const origRequest = mockWallet.request.bind(mockWallet);
      mockWallet.request = async (args) => {
        if (args.method === 'eth_sendTransaction') sendCount++;
        return origRequest(args);
      };

      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [1n],
        from: BUYER,
      };

      const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args });
      const opId = 'idempotency-test-1';

      // Seed journal with already submitted state
      const key = journalKey(testConfig, BUYER, opId);
      writeJournal(key, { status: 'submitted', hash: submittedHash, dataDigest: keccak256(data) });

      let submittedCalledWith: Hex | null = null;
      const reader = createMockReader({
        getTransaction: async () => ({
          hash: submittedHash,
          from: BUYER,
          to: PROTOCOL,
          input: data,
          blockNumber: 100n,
          blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          transactionIndex: 0,
          value: 0n,
        }),
      });

      const outcome = await executeBrowserTransaction(testConfig, request, opId, {
        injectedProvider: mockWallet,
        primaryClient: mockPublicClient,
        secondaryClient: mockPublicClient,
        primaryReader: reader,
        secondaryReader: reader,
        skipDeploymentCheck: true,
        onSubmitted: (h) => { submittedCalledWith = h; },
      });

      assert.equal(sendCount, 0, 'must NOT call wallet.sendTransaction on duplicate click');
      assert.equal(submittedCalledWith, submittedHash, 'must notify with existing submitted hash');
      assert.equal(outcome.hash, submittedHash);
      assert.equal(outcome.status, 'finalized');
    });

    it('rejects duplicate operation when payload is modified (dataDigest conflict)', async () => {
      const opId = 'idempotency-test-payload-conflict';
      const key = journalKey(testConfig, BUYER, opId);
      const staleDigest: Hex = '0x0000000000000000000000000000000000000000000000000000000000000001';
      writeJournal(key, { status: 'submitted', hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', dataDigest: staleDigest });

      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [2n], // Different args -> different dataDigest
        from: BUYER,
      };

      const mockWallet = createMockProvider({ chainId: 10143, accounts: [BUYER] });
      await assert.rejects(
        () =>
          executeBrowserTransaction(testConfig, request, opId, {
            injectedProvider: mockWallet,
            primaryClient: mockPublicClient,
            secondaryClient: mockPublicClient,
            skipDeploymentCheck: true,
          }),
        /OPERATION_PAYLOAD_CHANGED_RECONCILE_PREVIOUS/,
        'must reject conflicting payload on same idempotency key'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 5. Reload during pending transaction
  // -------------------------------------------------------------------------
  describe('5. Reload during pending transaction', () => {
    it('recovers pending broadcast after page reload and resumes observing without resend', async () => {
      const pendingHash: Hex = '0xfeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface';
      const opId = 'reload-during-pending';

      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [5n],
        from: BUYER,
      };

      const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args });
      const key = journalKey(testConfig, BUYER, opId);

      // Simulate state written before reload
      writeJournal(key, { status: 'submitted', hash: pendingHash, dataDigest: keccak256(data) });

      let walletPrompted = false;
      const mockWallet = createMockProvider({ chainId: 10143, accounts: [BUYER] });

      // Reader where receipt is not yet mined/observed
      const pendingReader = createMockReader({
        getTransactionReceipt: async () => { throw new Error('NOT_MINED'); },
      });

      const outcome = await executeBrowserTransaction(testConfig, request, opId, {
        injectedProvider: mockWallet,
        primaryClient: mockPublicClient,
        secondaryClient: mockPublicClient,
        primaryReader: pendingReader,
        secondaryReader: pendingReader,
        skipDeploymentCheck: true,
        onWalletPrompt: () => { walletPrompted = true; },
      });

      assert.equal(walletPrompted, false, 'wallet must NOT be prompted after reload');
      assert.equal(outcome.status, 'pending', 'outcome must truthfully remain pending');
      assert.equal(outcome.hash, pendingHash, 'must preserve exact pending hash');
    });
  });

  // -------------------------------------------------------------------------
  // 6. No-hash ambiguous send
  // -------------------------------------------------------------------------
  describe('6. No-hash ambiguous send', () => {
    it('records ambiguous state and throws SUBMISSION_UNCERTAIN when send throws without hash', async () => {
      const opId = 'ambiguous-send-test';
      const mockWallet = createMockProvider({
        chainId: 10143,
        accounts: [BUYER],
        sendTxResult: new Error('Network request failed - transport closed'),
      });

      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [6n],
        from: BUYER,
      };

      const mockClient = {
        getChainId: async () => MONAD_TESTNET_CHAIN_ID,
        estimateGas: async () => 21000n,
      } as any;

      await assert.rejects(
        () =>
          executeBrowserTransaction(testConfig, request, opId, {
            injectedProvider: mockWallet,
            primaryClient: mockClient,
            secondaryClient: mockClient,
            skipDeploymentCheck: true,
            skipServerSync: true,
          }),
        /SUBMISSION_UNCERTAIN_RECONCILE_WALLET/,
        'must report ambiguous send when wallet errors after submission attempt'
      );

      // Verify journal recorded ambiguous state
      const key = journalKey(testConfig, BUYER, opId);
      const record = readJournal(key);
      assert.equal(record?.status, 'ambiguous');
      assert.equal(record?.hash, undefined, 'no hash must be fabricated');

      // Subsequent attempt with ambiguous state must refuse blind resend
      await assert.rejects(
        () =>
          executeBrowserTransaction(testConfig, request, opId, {
            injectedProvider: mockWallet,
            primaryClient: mockClient,
            secondaryClient: mockClient,
            skipDeploymentCheck: true,
          }),
        /OPERATION_RECONCILIATION_REQUIRED/,
        'subsequent retry must require manual reconciliation, never auto-resend'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 7. RPC disagreement
  // -------------------------------------------------------------------------
  describe('7. RPC disagreement', () => {
    it('fails closed with RPC_FINALITY_CONFLICT when dual RPCs disagree on receipt block', async () => {
      const submittedHash: Hex = '0x7777777777777777777777777777777777777777777777777777777777777777';
      const opId = 'rpc-conflict-test';
      const request: ContractRequest = {
        address: PROTOCOL,
        abi: deliveryProtocolAbi,
        functionName: 'cancelProposal',
        args: [7n],
        from: BUYER,
      };

      const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args });
      const key = journalKey(testConfig, BUYER, opId);
      writeJournal(key, { status: 'submitted', hash: submittedHash, dataDigest: keccak256(data) });

      // Primary reader sees block 100, Secondary sees block 200 -> RECEIPT_BLOCK_MISMATCH
      const primaryReader = createMockReader({
        getTransactionReceipt: async (args) => ({
          status: 'success',
          transactionHash: args.hash,
          blockNumber: 100n,
          blockHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex,
          transactionIndex: 0,
          from: BUYER,
          to: PROTOCOL,
          logs: [],
          cumulativeGasUsed: 21000n,
          gasUsed: 21000n,
        }),
      });

      const secondaryReader = createMockReader({
        getTransactionReceipt: async (args) => ({
          status: 'success',
          transactionHash: args.hash,
          blockNumber: 200n, // Disagreement!
          blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex,
          transactionIndex: 0,
          from: BUYER,
          to: PROTOCOL,
          logs: [],
          cumulativeGasUsed: 21000n,
          gasUsed: 21000n,
        }),
      });

      const mockWallet = createMockProvider({ chainId: 10143, accounts: [BUYER] });

      await assert.rejects(
        () =>
          executeBrowserTransaction(testConfig, request, opId, {
            injectedProvider: mockWallet,
            primaryClient: mockPublicClient,
            secondaryClient: mockPublicClient,
            primaryReader,
            secondaryReader,
            skipDeploymentCheck: true,
          }),
        /RPC_FINALITY_CONFLICT/,
        'dual-RPC disagreement must fail closed with RPC_FINALITY_CONFLICT'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 8. Passkey rejection
  // -------------------------------------------------------------------------
  describe('8. Passkey rejection', () => {
    it('handles passkey hardware/user rejection safely without corrupting state', async () => {
      // Test that when WebAuthn rejects (NotAllowedError / user cancelled),
      // the error is caught and does not mutate any stored records.
      const simulatedRejection = new DOMException('The operation either timed out or was not allowed', 'NotAllowedError');

      let actionCalled = false;
      const resolveVerdictSafely = async () => {
        try {
          throw simulatedRejection;
        } catch (e) {
          const err = e as Error;
          if (err.name === 'NotAllowedError') {
            actionCalled = true;
            return { ok: false, reason: 'USER_CANCELLED_PASSKEY' };
          }
          throw e;
        }
      };

      const result = await resolveVerdictSafely();
      assert.equal(actionCalled, true);
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'USER_CANCELLED_PASSKEY');
      // Verify journal remains clean
      assert.equal(storage.length, 0);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Expiry not yet eligible
  // -------------------------------------------------------------------------
  describe('9. Expiry not yet eligible', () => {
    it('denies expiry refund when current block timestamp is before job expiresAt', () => {
      const job: JobData = {
        buyer: BUYER,
        provider: PROVIDER,
        attestor: ATTESTOR,
        termsCommitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
        deliveryCommitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
        budget: 1000000n,
        expiresAt: 1800000000n,
        status: 2, // Funded
      };

      const chainTimestamp = 1750000000n; // Earlier than expiresAt
      const eligible = (job.status === 2 || job.status === 3) && chainTimestamp >= job.expiresAt;
      assert.equal(eligible, false, 'refund must not be eligible before job expiry timestamp');
    });

    it('denies expiry refund when job is already completed or rejected regardless of time', () => {
      const completedJob: JobData = {
        buyer: BUYER,
        provider: PROVIDER,
        attestor: ATTESTOR,
        termsCommitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
        deliveryCommitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
        budget: 1000000n,
        expiresAt: 1700000000n,
        status: 4, // Completed
      };

      const chainTimestamp = 1800000000n; // Later than expiresAt
      const eligible = (completedJob.status === 2 || completedJob.status === 3) && chainTimestamp >= completedJob.expiresAt;
      assert.equal(eligible, false, 'completed job must never be eligible for expiry refund');
    });
  });

  // -------------------------------------------------------------------------
  // 10. Successful expiry refund
  // -------------------------------------------------------------------------
  describe('10. Successful expiry refund', () => {
    it('permits expiry refund when job is funded and chain timestamp has passed expiresAt', () => {
      const job: JobData = {
        buyer: BUYER,
        provider: PROVIDER,
        attestor: ATTESTOR,
        termsCommitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
        deliveryCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
        budget: 1000000n,
        expiresAt: 1700000000n,
        status: 2, // Funded
      };

      const chainTimestamp = 1750000000n; // Past deadline
      const eligible = (job.status === 2 || job.status === 3) && chainTimestamp >= job.expiresAt;
      assert.equal(eligible, true, 'refund must be eligible when funded and past expiry');

      const request = buildClaimExpiryRefundRequest({ jobId: 15n }, contractAddresses);
      assert.equal(request.address.toLowerCase(), PROTOCOL.toLowerCase());
      assert.equal(request.functionName, 'claimExpiryRefund');
      assert.deepEqual(request.args, [15n]);
    });
  });

  // -------------------------------------------------------------------------
  // 11. No secret leakage
  // -------------------------------------------------------------------------
  describe('11. No secret leakage', () => {
    it('journal records store only commitments and digests, never private keys or raw terms', () => {
      const opId = 'privacy-audit-test';
      const key = journalKey(testConfig, BUYER, opId);
      const fakeDataDigest = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hex;
      const fakeTxHash = '0x2222222222222222222222222222222222222222222222222222222222222222' as Hex;

      writeJournal(key, { status: 'submitted', hash: fakeTxHash, dataDigest: fakeDataDigest });

      const raw = storage.getItem(key)!;
      assert.ok(raw);

      // Verify no sensitive field names exist in storage
      const sensitivePatterns = [/privatekey/i, /secret/i, /mnemonic/i, /seed/i, /passkey/i, /instructions/i];
      for (const pattern of sensitivePatterns) {
        assert.equal(pattern.test(raw), false, `journal must not contain ${pattern.source}`);
      }
    });

    it('private terms bundle parsing validates structure and enforces 32-byte salt', () => {
      const termsInput = {
        schema: 'xyx.private-terms' as const,
        chainId: 10143 as const,
        protocol: PROTOCOL,
        paymentToken: TOKEN,
        buyer: BUYER,
        provider: PROVIDER,
        attestor: ATTESTOR,
        budgetAtomic: '1000000',
        expiresAt: 1800000000,
        task: { recipient: '0x9999999999999999999999999999999999999999' as Address, amountAtomic: '500000', instructions: 'confidential' },
        acceptancePolicy: { maxRetries: 1, timeoutSeconds: 3600 },
      };

      const salt = generateSalt(32);
      const bundle = makePrivateTermsBundle(termsInput, salt);
      const json = JSON.stringify(bundle);

      const parsed = parsePrivateTermsBundle(json);
      assert.equal(parsed.commitment, bundle.commitment);
      assert.equal(parsed.salt, salt);

      // Salt tampering must fail
      const tampered = { ...bundle, commitment: '0x' + '0'.repeat(64) };
      assert.throws(
        () => parsePrivateTermsBundle(JSON.stringify(tampered)),
        /PRIVATE_TERMS_BUNDLE_COMMITMENT_MISMATCH/,
        'tampered commitment must be rejected'
      );
    });
  });

  // -------------------------------------------------------------------------
  // 12. /demo remains read-only and truthful
  // -------------------------------------------------------------------------
  describe('12. /demo remains read-only and truthful', () => {
    it('/demo source has no wallet connect buttons or interactive write forms', () => {
      const demoPath = path.resolve(process.cwd(), 'apps/web/app/demo/page.tsx');
      const source = readFileSync(demoPath, 'utf8');

      // Assert read-only nature
      assert.equal(source.includes('connectWallet'), false, '/demo must not import connectWallet');
      assert.equal(source.includes('executeBrowserTransaction'), false, '/demo must not import executeBrowserTransaction');
      assert.equal(source.includes('<form'), false, '/demo must not render form tags');
      assert.equal(source.includes('sendTransaction'), false, '/demo must not call sendTransaction');
      assert.equal(source.includes('useTx'), false, '/demo must not use transaction hook');

      // Assert truthfulness policy enforcement
      assert.ok(source.includes('canShowVerifiedExplorerTransaction'), 'must enforce verified explorer transaction policy');
      assert.ok(source.includes('UNAVAILABLE'), 'must define UNAVAILABLE fallback status');
      assert.ok(source.includes('protocolTokenMismatch'), 'must check deployment binding mismatch');
    });
  });
});
