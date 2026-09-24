import type {
  Abi,
  Address,
  Hex,
} from 'viem';
import {
  createPublicClient,
  http,
  sha256,
  toBytes,
} from 'viem';
import { monadTestnet } from 'viem/chains';

import { MONAD_TESTNET_CHAIN_ID } from './config';
import { validateConfig } from './config';
import type { XYXConfig } from './config';

// ---------------------------------------------------------------------------
// Canonical ABIs
// ---------------------------------------------------------------------------

/**
 * Minimal ABI for the XYXDeliveryProtocol contract.
 * Contains only the functions and events the reference UI reads or writes.
 *
 * Validated against XYXDeliveryProtocol.sol.
 */
export const deliveryProtocolAbi = [
  { type: 'function', name: 'getJob', inputs: [{ name: 'jobId', type: 'uint256', internalType: 'uint256' }], outputs: [{ name: '', type: 'tuple', internalType: 'struct XYXDeliveryProtocol.Job', components: [
    { name: 'buyer', type: 'address', internalType: 'address' },
    { name: 'provider', type: 'address', internalType: 'address' },
    { name: 'attestor', type: 'address', internalType: 'address' },
    { name: 'termsCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'deliveryCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'budget', type: 'uint256', internalType: 'uint256' },
    { name: 'expiresAt', type: 'uint64', internalType: 'uint64' },
    { name: 'status', type: 'uint8', internalType: 'enum XYXDeliveryProtocol.JobStatus' },
  ] }], stateMutability: 'view' },
  { type: 'function', name: 'jobCounter', inputs: [], outputs: [{ name: '', type: 'uint256', internalType: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'consumedVerdicts', inputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }], outputs: [{ name: '', type: 'bool', internalType: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'usedNonces', inputs: [
    { name: '', type: 'address', internalType: 'address' },
    { name: '', type: 'uint64', internalType: 'uint64' },
  ], outputs: [{ name: '', type: 'bool', internalType: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'VERDICT_TYPEHASH', inputs: [], outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'eip712Domain', inputs: [], outputs: [
    { name: 'fields', type: 'bytes1', internalType: 'bytes1' },
    { name: 'name', type: 'string', internalType: 'string' },
    { name: 'version', type: 'string', internalType: 'string' },
    { name: 'chainId', type: 'uint256', internalType: 'uint256' },
    { name: 'verifyingContract', type: 'address', internalType: 'address' },
    { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
    { name: 'extensions', type: 'uint256[]', internalType: 'uint256[]' },
  ], stateMutability: 'view' },
  { type: 'function', name: 'paymentToken', inputs: [], outputs: [{ name: '', type: 'address', internalType: 'contract IERC20' }], stateMutability: 'view' },
  { type: 'function', name: 'passkeyRegistry', inputs: [], outputs: [{ name: '', type: 'address', internalType: 'contract XYXPasskeyRegistry' }], stateMutability: 'view' },
  { type: 'function', name: 'maxVerdictLifetime', inputs: [], outputs: [{ name: '', type: 'uint64', internalType: 'uint64' }], stateMutability: 'view' },
  { type: 'function', name: 'hashVerdict', inputs: [{ name: 'verdict', type: 'tuple', internalType: 'struct XYXDeliveryProtocol.JobVerdict', components: [
    { name: 'jobId', type: 'uint256', internalType: 'uint256' },
    { name: 'termsCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'deliveryCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'evidenceCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'reasonCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'decision', type: 'uint8', internalType: 'uint8' },
    { name: 'issuedAt', type: 'uint64', internalType: 'uint64' },
    { name: 'expiresAt', type: 'uint64', internalType: 'uint64' },
    { name: 'nonce', type: 'uint64', internalType: 'uint64' },
  ] }], outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'proposeJob', inputs: [
    { name: 'provider', type: 'address', internalType: 'address' },
    { name: 'attestor', type: 'address', internalType: 'address' },
    { name: 'termsCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'budget', type: 'uint256', internalType: 'uint256' },
    { name: 'expiresAt', type: 'uint64', internalType: 'uint64' },
  ], outputs: [{ name: 'jobId', type: 'uint256', internalType: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'acceptJob', inputs: [{ name: 'jobId', type: 'uint256', internalType: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'cancelProposal', inputs: [{ name: 'jobId', type: 'uint256', internalType: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'fundJob', inputs: [{ name: 'jobId', type: 'uint256', internalType: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'submitDelivery', inputs: [
    { name: 'jobId', type: 'uint256', internalType: 'uint256' },
    { name: 'deliveryCommitment', type: 'bytes32', internalType: 'bytes32' },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'resolveJob', inputs: [
    { name: 'verdict', type: 'tuple', internalType: 'struct XYXDeliveryProtocol.JobVerdict', components: [
      { name: 'jobId', type: 'uint256', internalType: 'uint256' },
      { name: 'termsCommitment', type: 'bytes32', internalType: 'bytes32' },
      { name: 'deliveryCommitment', type: 'bytes32', internalType: 'bytes32' },
      { name: 'evidenceCommitment', type: 'bytes32', internalType: 'bytes32' },
      { name: 'reasonCommitment', type: 'bytes32', internalType: 'bytes32' },
      { name: 'decision', type: 'uint8', internalType: 'uint8' },
      { name: 'issuedAt', type: 'uint64', internalType: 'uint64' },
      { name: 'expiresAt', type: 'uint64', internalType: 'uint64' },
      { name: 'nonce', type: 'uint64', internalType: 'uint64' },
    ] },
    { name: 'assertion', type: 'tuple', internalType: 'struct WebAuthn.WebAuthnAuth', components: [
      { name: 'r', type: 'bytes32', internalType: 'bytes32' },
      { name: 's', type: 'bytes32', internalType: 'bytes32' },
      { name: 'challengeIndex', type: 'uint256', internalType: 'uint256' },
      { name: 'typeIndex', type: 'uint256', internalType: 'uint256' },
      { name: 'authenticatorData', type: 'bytes', internalType: 'bytes' },
      { name: 'clientDataJSON', type: 'string', internalType: 'string' },
    ] },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'claimExpiryRefund', inputs: [{ name: 'jobId', type: 'uint256', internalType: 'uint256' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'event', name: 'JobProposed', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'buyer', type: 'address', indexed: true, internalType: 'address' },
    { name: 'provider', type: 'address', indexed: true, internalType: 'address' },
    { name: 'attestor', type: 'address', indexed: false, internalType: 'address' },
    { name: 'termsCommitment', type: 'bytes32', indexed: false, internalType: 'bytes32' },
    { name: 'budget', type: 'uint256', indexed: false, internalType: 'uint256' },
    { name: 'expiresAt', type: 'uint64', indexed: false, internalType: 'uint64' },
  ], anonymous: false },
  { type: 'event', name: 'JobAccepted', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'provider', type: 'address', indexed: true, internalType: 'address' },
  ], anonymous: false },
  { type: 'event', name: 'JobFunded', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'buyer', type: 'address', indexed: true, internalType: 'address' },
    { name: 'budget', type: 'uint256', indexed: false, internalType: 'uint256' },
  ], anonymous: false },
  { type: 'event', name: 'DeliverySubmitted', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'provider', type: 'address', indexed: true, internalType: 'address' },
    { name: 'deliveryCommitment', type: 'bytes32', indexed: false, internalType: 'bytes32' },
  ], anonymous: false },
  { type: 'event', name: 'JobResolved', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'attestor', type: 'address', indexed: true, internalType: 'address' },
    { name: 'decision', type: 'uint8', indexed: false, internalType: 'uint8' },
    { name: 'verdictDigest', type: 'bytes32', indexed: true, internalType: 'bytes32' },
    { name: 'evidenceCommitment', type: 'bytes32', indexed: false, internalType: 'bytes32' },
    { name: 'reasonCommitment', type: 'bytes32', indexed: false, internalType: 'bytes32' },
  ], anonymous: false },
  { type: 'event', name: 'JobExpired', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'buyer', type: 'address', indexed: true, internalType: 'address' },
    { name: 'budget', type: 'uint256', indexed: false, internalType: 'uint256' },
  ], anonymous: false },
  { type: 'event', name: 'PaymentReleased', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'recipient', type: 'address', indexed: true, internalType: 'address' },
    { name: 'budget', type: 'uint256', indexed: false, internalType: 'uint256' },
  ], anonymous: false },
  { type: 'event', name: 'JobCancelled', inputs: [
    { name: 'jobId', type: 'uint256', indexed: true, internalType: 'uint256' },
    { name: 'buyer', type: 'address', indexed: true, internalType: 'address' },
  ], anonymous: false },
] as const satisfies Abi;

/**
 * Minimal ABI for XYXPasskeyRegistry.
 */
export const passkeyRegistryAbi = [
  { type: 'function', name: 'registrationChallenge', inputs: [
    { name: 'owner', type: 'address' },
    { name: 'credentialIdCommitment', type: 'bytes32' },
    { name: 'qx', type: 'bytes32' },
    { name: 'qy', type: 'bytes32' },
  ], outputs: [{ name: '', type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'registerCredential', inputs: [
    { name: 'credentialIdCommitment', type: 'bytes32' },
    { name: 'qx', type: 'bytes32' },
    { name: 'qy', type: 'bytes32' },
    { name: 'assertion', type: 'tuple', components: [
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
      { name: 'challengeIndex', type: 'uint256' },
      { name: 'typeIndex', type: 'uint256' },
      { name: 'authenticatorData', type: 'bytes' },
      { name: 'clientDataJSON', type: 'string' },
    ] },
  ], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'credentialOf', inputs: [{ name: 'owner', type: 'address', internalType: 'address' }], outputs: [{ name: '', type: 'tuple', internalType: 'struct XYXPasskeyRegistry.Credential', components: [
    { name: 'credentialIdCommitment', type: 'bytes32', internalType: 'bytes32' },
    { name: 'qx', type: 'bytes32', internalType: 'bytes32' },
    { name: 'qy', type: 'bytes32', internalType: 'bytes32' },
    { name: 'signCount', type: 'uint32', internalType: 'uint32' },
    { name: 'exists', type: 'bool', internalType: 'bool' },
  ] }], stateMutability: 'view' },
  { type: 'function', name: 'assertionChallenge', inputs: [
    { name: 'consumer', type: 'address', internalType: 'address' },
    { name: 'owner', type: 'address', internalType: 'address' },
    { name: 'actionDigest', type: 'bytes32', internalType: 'bytes32' },
  ], outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'rpIdHash', inputs: [], outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'p256Verifier', inputs: [], outputs: [{ name: '', type: 'address', internalType: 'contract IP256Verifier' }], stateMutability: 'view' },
  { type: 'event', name: 'CredentialRegistered', inputs: [
    { name: 'owner', type: 'address', indexed: true, internalType: 'address' },
    { name: 'credentialIdCommitment', type: 'bytes32', indexed: true, internalType: 'bytes32' },
    { name: 'qx', type: 'bytes32', indexed: false, internalType: 'bytes32' },
    { name: 'qy', type: 'bytes32', indexed: false, internalType: 'bytes32' },
  ], anonymous: false },
  { type: 'event', name: 'AssertionConsumed', inputs: [
    { name: 'owner', type: 'address', indexed: true, internalType: 'address' },
    { name: 'consumer', type: 'address', indexed: true, internalType: 'address' },
    { name: 'actionDigest', type: 'bytes32', indexed: true, internalType: 'bytes32' },
    { name: 'signCount', type: 'uint32', indexed: false, internalType: 'uint32' },
  ], anonymous: false },
] as const satisfies Abi;

// Export ABIs as a bundle for request builders
export const ABIs = {
  deliveryProtocol: deliveryProtocolAbi,
  passkeyRegistry: passkeyRegistryAbi,
} as const;

export type JobStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface JobData {
  buyer: Address;
  provider: Address;
  attestor: Address;
  termsCommitment: Hex;
  deliveryCommitment: Hex;
  budget: bigint;
  expiresAt: bigint;
  status: JobStatus;
}

export interface JobVerdictData {
  jobId: bigint;
  termsCommitment: Hex;
  deliveryCommitment: Hex;
  evidenceCommitment: Hex;
  reasonCommitment: Hex;
  decision: 1 | 2;
  issuedAt: bigint;
  expiresAt: bigint;
  nonce: bigint;
}

export interface PasskeyCredential {
  credentialIdCommitment: Hex;
  qx: Hex;
  qy: Hex;
  signCount: number;
  exists: boolean;
}

export type TxStatus = 'idle' | 'draft' | 'submitted' | 'pending' | 'finalized' | 'reverted' | 'user_cancelled';

// Config type mirrors

export type ProtocolChainReader = ReturnType<typeof createXYXClient>;

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function createXYXClient(rpcUrl: string) {
  return createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl, { timeout: 10_000 }),
  });
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

export async function readJob(
  client: ReturnType<typeof createXYXClient>,
  protocolAddress: Address,
  jobId: bigint
): Promise<JobData> {
  const job = await client.readContract({
    address: protocolAddress,
    abi: deliveryProtocolAbi,
    functionName: 'getJob',
    args: [jobId],
  });
  return job as unknown as JobData;
}

export async function readJobCounter(
  client: ReturnType<typeof createXYXClient>,
  protocolAddress: Address
): Promise<bigint> {
  return client.readContract({
    address: protocolAddress,
    abi: deliveryProtocolAbi,
    functionName: 'jobCounter',
  });
}

export async function readPaymentToken(
  client: ReturnType<typeof createXYXClient>,
  protocolAddress: Address
): Promise<Address> {
  return client.readContract({
    address: protocolAddress,
    abi: deliveryProtocolAbi,
    functionName: 'paymentToken',
  });
}

export async function readMaxVerdictLifetime(
  client: ReturnType<typeof createXYXClient>,
  protocolAddress: Address
): Promise<bigint> {
  return client.readContract({
    address: protocolAddress,
    abi: deliveryProtocolAbi,
    functionName: 'maxVerdictLifetime',
  });
}

export async function readCredentialOf(
  client: ReturnType<typeof createXYXClient>,
  registryAddress: Address,
  owner: Address
): Promise<PasskeyCredential> {
  const cred = await client.readContract({
    address: registryAddress,
    abi: passkeyRegistryAbi,
    functionName: 'credentialOf',
    args: [owner],
  });
  return cred as unknown as PasskeyCredential;
}

export async function readRegistryRpIdHash(
  client: ReturnType<typeof createXYXClient>,
  registryAddress: Address
): Promise<Hex> {
  return client.readContract({
    address: registryAddress,
    abi: passkeyRegistryAbi,
    functionName: 'rpIdHash',
  });
}

// ---------------------------------------------------------------------------
// Status label mapping
// ---------------------------------------------------------------------------

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  0: 'Proposed',
  1: 'Accepted',
  2: 'Funded',
  3: 'Submitted',
  4: 'Completed',
  5: 'Rejected',
  6: 'Expired',
  7: 'Cancelled',
};

export function jobStatusLabel(status: JobStatus): string {
  return JOB_STATUS_LABELS[status] ?? 'Unknown';
}

// ---------------------------------------------------------------------------
// Configuration validation for the reference client
// ---------------------------------------------------------------------------

export interface ProtocolConfigStatus {
  chainValid: boolean;
  observedChainId: number | null;
  secondaryObservedChainId?: number | null;
  protocolHasCode: boolean;
  registryHasCode: boolean;
  verifierHasCode: boolean;
  config: XYXConfig | undefined;
  errors: string[];
}

export async function validateProtocolConfig(config: XYXConfig): Promise<ProtocolConfigStatus> {
  const errors = validateConfig(config).errors;
  const result: ProtocolConfigStatus = {
    chainValid: false,
    observedChainId: null,
    secondaryObservedChainId: null,
    protocolHasCode: false,
    registryHasCode: false,
    verifierHasCode: false,
    config,
    errors,
  };
  if (errors.length !== 0 || !config.paymentTokenAddress || !config.secondaryRpcUrl) return result;

  const primary = createXYXClient(config.rpcUrl);
  const secondary = createXYXClient(config.secondaryRpcUrl);
  try {
    const [first, second] = await Promise.all([primary.getChainId(), secondary.getChainId()]);
    result.observedChainId = first;
    result.secondaryObservedChainId = second;
    result.chainValid = first === MONAD_TESTNET_CHAIN_ID && second === MONAD_TESTNET_CHAIN_ID;
    if (!result.chainValid) errors.push('WRONG_NETWORK');
  } catch {
    errors.push('RPC_CHAIN_READ_FAILED');
  }
  if (!result.chainValid) return result;

  const addresses = [config.protocolAddress, config.registryAddress, config.p256VerifierAddress, config.paymentTokenAddress];
  try {
    const [firstCode, secondCode] = await Promise.all([
      Promise.all(addresses.map(address => primary.getBytecode({ address }))),
      Promise.all(addresses.map(address => secondary.getBytecode({ address }))),
    ]);
    for (let index = 0; index < addresses.length; index++) {
      if (!firstCode[index] || firstCode[index] === '0x' || !secondCode[index] || secondCode[index] === '0x') {
        errors.push(['PROTOCOL_NO_CODE', 'REGISTRY_NO_CODE', 'VERIFIER_NO_CODE', 'PAYMENT_TOKEN_NO_CODE'][index]);
      } else if (firstCode[index]!.toLowerCase() !== secondCode[index]!.toLowerCase()) {
        errors.push(['PROTOCOL_CODE_MISMATCH', 'REGISTRY_CODE_MISMATCH', 'VERIFIER_CODE_MISMATCH', 'TOKEN_CODE_MISMATCH'][index]);
      }
    }
    result.protocolHasCode = !errors.includes('PROTOCOL_NO_CODE') && !errors.includes('PROTOCOL_CODE_MISMATCH');
    result.registryHasCode = !errors.includes('REGISTRY_NO_CODE') && !errors.includes('REGISTRY_CODE_MISMATCH');
    result.verifierHasCode = !errors.includes('VERIFIER_NO_CODE') && !errors.includes('VERIFIER_CODE_MISMATCH');
  } catch {
    errors.push('BYTECODE_READ_FAILED');
  }
  if (errors.length !== 0) return result;

  const readBindings = async (client: ReturnType<typeof createXYXClient>) => Promise.all([
    client.readContract({ address: config.protocolAddress, abi: deliveryProtocolAbi, functionName: 'paymentToken' }),
    client.readContract({ address: config.protocolAddress, abi: deliveryProtocolAbi, functionName: 'passkeyRegistry' }),
    client.readContract({ address: config.registryAddress, abi: passkeyRegistryAbi, functionName: 'p256Verifier' }),
    client.readContract({ address: config.registryAddress, abi: passkeyRegistryAbi, functionName: 'rpIdHash' }),
    client.readContract({ address: config.paymentTokenAddress!, abi: [{ type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] }] as const, functionName: 'decimals' }),
  ] as const);
  try {
    const [first, second] = await Promise.all([readBindings(primary), readBindings(secondary)]);
    const expected = [config.paymentTokenAddress.toLowerCase(), config.registryAddress.toLowerCase(), config.p256VerifierAddress.toLowerCase(), sha256(toBytes(config.rpId)).toLowerCase(), 6];
    const codes = ['PAYMENT_TOKEN_BINDING_MISMATCH', 'REGISTRY_BINDING_MISMATCH', 'VERIFIER_BINDING_MISMATCH', 'RP_ID_HASH_MISMATCH', 'TOKEN_DECIMALS_MISMATCH'];
    for (let index = 0; index < first.length; index++) {
      const firstValue = first[index];
      const secondValue = second[index];
      const a = typeof firstValue === 'string' ? firstValue.toLowerCase() : firstValue;
      const b = typeof secondValue === 'string' ? secondValue.toLowerCase() : secondValue;
      if (a !== b || a !== expected[index]) errors.push(codes[index]);
    }
  } catch {
    errors.push('BINDING_READ_FAILED');
  }
  return result;
}
