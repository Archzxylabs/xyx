/**
 * Canonical JobVerdict EIP-712 digest.
 *
 * `XYXDeliveryProtocol.hashVerdict` hashes the verdict with `_hashTypedDataV4`,
 * so the domain binds name, version, chainId, and verifyingContract = protocol.
 * Every consumer (SDK, browser, settlement verifier) must use this single
 * implementation; a digest computed with the wrong chain or contract can never
 * be accepted on-chain.
 *
 * @module @xyx/monad/verdict
 */

import { encodeAbiParameters, keccak256, toHex, type AbiParameter, type Address, type Hex } from 'viem';

import type { JobVerdictData } from './protocol';

/** Monad Testnet is the only supported chain. */
export const VERDICT_CHAIN_ID = 10143;

export const VERDICT_TYPEHASH_STRING =
  'JobVerdict(uint256 jobId,bytes32 termsCommitment,bytes32 deliveryCommitment,bytes32 evidenceCommitment,bytes32 reasonCommitment,uint8 decision,uint64 issuedAt,uint64 expiresAt,uint64 nonce)';

export const EIP712_DOMAIN_TYPEHASH_STRING =
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

const VERDICT_TYPEHASH: Hex = keccak256(toHex(new TextEncoder().encode(VERDICT_TYPEHASH_STRING)));
const EIP712_DOMAIN_TYPEHASH: Hex = keccak256(toHex(new TextEncoder().encode(EIP712_DOMAIN_TYPEHASH_STRING)));

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HEX_WORD_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT64_MAX = BigInt('0xFFFFFFFFFFFFFFFF');

function bytes(hex: Hex): Uint8Array {
  return new Uint8Array(hex.slice(2).match(/.{2}/g)!.map(part => parseInt(part, 16)));
}

function concat(...parts: Hex[]): Uint8Array {
  const total = parts.reduce((length, part) => length + part.length - 2, 0);
  const out = new Uint8Array(total / 2);
  let offset = 0;
  for (const part of parts) {
    const chunk = bytes(part);
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * EIP-712 domain separator for the canonical protocol contract.
 */
export function computeVerdictDomainSeparator(
  verifyingContract: Address,
  chainId: number = VERDICT_CHAIN_ID
): Hex {
  if (typeof verifyingContract !== 'string' || !ADDRESS_RE.test(verifyingContract)) {
    throw new Error('INVALID_VERIFYING_CONTRACT: a 20-byte Hex protocol address is required');
  }
  if (verifyingContract === '0x0000000000000000000000000000000000000000') {
    throw new Error('INVALID_VERIFYING_CONTRACT: protocol address must not be zero');
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error('INVALID_CHAIN_ID: chainId must be a positive integer');
  }
  return keccak256(
    encodeAbiParameters(
      [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      ['XYX Delivery', '1', BigInt(chainId), verifyingContract]
    )
  );
}

const VERDICT_PARAMETERS: readonly AbiParameter[] = [
  { name: 'jobId', type: 'uint256' },
  { name: 'termsCommitment', type: 'bytes32' },
  { name: 'deliveryCommitment', type: 'bytes32' },
  { name: 'evidenceCommitment', type: 'bytes32' },
  { name: 'reasonCommitment', type: 'bytes32' },
  { name: 'decision', type: 'uint8' },
  { name: 'issuedAt', type: 'uint64' },
  { name: 'expiresAt', type: 'uint64' },
  { name: 'nonce', type: 'uint64' },
];

function assertCommitment(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !HEX_WORD_RE.test(value)) {
    throw new Error(`INVALID_VERDICT: ${field} must be a 32-byte Hex commitment`);
  }
  return value as Hex;
}

function assertUint64(value: unknown, field: string): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > UINT64_MAX) {
    throw new Error(`INVALID_VERDICT: ${field} must be a uint64 value`);
  }
  return value;
}

/**
 * Recompute the canonical EIP-712 digest of a JobVerdict.
 *
 * The returned digest is exactly what `XYXDeliveryProtocol.hashVerdict` returns
 * for the same verdict on the same chain and contract, and it is the value the
 * passkey registry binds to the attestor's action assertion.
 */
export function hashVerdictDigest(
  verdict: JobVerdictData,
  verifyingContract: Address,
  chainId: number = VERDICT_CHAIN_ID
): Hex {
  if (typeof verdict !== 'object' || verdict === null) {
    throw new Error('INVALID_VERDICT: verdict must be an object');
  }
  if (typeof verdict.jobId !== 'bigint' || verdict.jobId <= 0n) {
    throw new Error('INVALID_JOB_ID: jobId must be a positive integer');
  }
  if (verdict.decision !== 1 && verdict.decision !== 2) {
    throw new Error('INVALID_DECISION: must be 1 (complete) or 2 (reject)');
  }

  const structHash = keccak256(
    encodeAbiParameters(VERDICT_PARAMETERS, [
      verdict.jobId,
      assertCommitment(verdict.termsCommitment, 'termsCommitment'),
      assertCommitment(verdict.deliveryCommitment, 'deliveryCommitment'),
      assertCommitment(verdict.evidenceCommitment, 'evidenceCommitment'),
      assertCommitment(verdict.reasonCommitment, 'reasonCommitment'),
      BigInt(verdict.decision),
      assertUint64(verdict.issuedAt, 'issuedAt'),
      assertUint64(verdict.expiresAt, 'expiresAt'),
      assertUint64(verdict.nonce, 'nonce'),
    ])
  );

  const typedDataHash = keccak256(concat(VERDICT_TYPEHASH, structHash));
  return keccak256(concat(EIP712_DOMAIN_TYPEHASH, computeVerdictDomainSeparator(verifyingContract, chainId), typedDataHash));
}
