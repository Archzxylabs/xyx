/** Browser WebAuthn/P-256 ceremonies for the canonical registry. No PRF, mock, or persisted credential ID. */

import { hexToBytes, keccak256, sha256, toBytes, toHex, type Hex } from 'viem';
import type { WebAuthnAssertionInput } from './delivery-chain';

function browser(rpId: string): void {
  if (typeof window === 'undefined' || !window.isSecureContext || !navigator.credentials) {
    throw new Error('WEBAUTHN_SECURE_BROWSER_REQUIRED');
  }
  const host = window.location.hostname;
  if (rpId !== host && !host.endsWith(`.${rpId}`)) throw new Error('WEBAUTHN_RP_ID_ORIGIN_MISMATCH');
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

/** Solidity indexes UTF-8 bytes, not JavaScript UTF-16 code units. */
export function byteOffsetOf(haystack: Uint8Array, asciiNeedle: string): number {
  const needle = new TextEncoder().encode(asciiNeedle);
  for (let start = 0; start <= haystack.length - needle.length; start++) {
    let matches = true;
    for (let index = 0; index < needle.length; index++) {
      if (haystack[start + index] !== needle[index]) { matches = false; break; }
    }
    if (matches) return start;
  }
  return -1;
}

/** ASN.1 DER ECDSA signature → fixed 32-byte r and s, allowing a sign-padding byte. */
export function parseP256DerSignature(signature: Uint8Array): { r: Hex; s: Hex } {
  let cursor = 0;
  if (signature[cursor++] !== 0x30) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
  const sequenceLength = signature[cursor++];
  if (sequenceLength !== signature.length - 2) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
  const readInteger = (): Hex => {
    if (signature[cursor++] !== 0x02) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
    const length = signature[cursor++];
    if (!length || length > 33 || cursor + length > signature.length) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
    let bytes = signature.slice(cursor, cursor + length);
    cursor += length;
    const hadSignPadding = bytes.length === 33;
    if (bytes.length === 33) {
      if (bytes[0] !== 0) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
      bytes = bytes.slice(1);
    }
    if (bytes.length > 32 || (!hadSignPadding && (bytes[0] & 0x80) !== 0)) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
    const padded = new Uint8Array(32);
    padded.set(bytes, 32 - bytes.length);
    return toHex(padded);
  };
  const r = readInteger();
  const s = readInteger();
  if (cursor !== signature.length) throw new Error('WEBAUTHN_SIGNATURE_DER_INVALID');
  return { r, s };
}

export interface NewPasskey {
  credentialIdCommitment: Hex;
  qx: Hex;
  qy: Hex;
  /** Transient only: do not log, serialize, or persist this credential ID. */
  credentialId: Uint8Array;
}

export async function createNativePasskey(rpId: string, userName: string): Promise<NewPasskey> {
  browser(rpId);
  if (!userName.trim()) throw new Error('WEBAUTHN_USER_NAME_REQUIRED');
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const userId = crypto.getRandomValues(new Uint8Array(32));
  const created = await navigator.credentials.create({ publicKey: {
    challenge: challenge as BufferSource,
    rp: { id: rpId, name: 'XYX' },
    user: { id: userId as BufferSource, name: userName, displayName: userName },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    attestation: 'none',
    timeout: 120_000,
  } }) as PublicKeyCredential | null;
  if (!created) throw new Error('WEBAUTHN_CREATION_CANCELLED');
  const response = created.response as AuthenticatorAttestationResponse;
  if (response.getPublicKeyAlgorithm() !== -7) throw new Error('WEBAUTHN_ES256_REQUIRED');
  const spki = response.getPublicKey();
  if (!spki) throw new Error('WEBAUTHN_PUBLIC_KEY_UNAVAILABLE');
  const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (!jwk.x || !jwk.y) throw new Error('WEBAUTHN_PUBLIC_KEY_INVALID');
  const x = fromBase64url(jwk.x);
  const y = fromBase64url(jwk.y);
  if (x.length !== 32 || y.length !== 32) throw new Error('WEBAUTHN_PUBLIC_KEY_INVALID');
  const credentialId = new Uint8Array(created.rawId);
  return { credentialIdCommitment: keccak256(toHex(credentialId)), qx: toHex(x), qy: toHex(y), credentialId };
}

export async function assertNativePasskey(
  rpId: string,
  challenge: Hex,
  expectedCredentialIdCommitment: Hex,
  credentialId?: Uint8Array,
): Promise<WebAuthnAssertionInput> {
  browser(rpId);
  if (!/^0x[0-9a-fA-F]{64}$/.test(challenge)) throw new Error('WEBAUTHN_CHALLENGE_INVALID');
  if (!/^0x[0-9a-fA-F]{64}$/.test(expectedCredentialIdCommitment)) throw new Error('WEBAUTHN_CREDENTIAL_COMMITMENT_INVALID');
  const requestedChallenge = hexToBytes(challenge);
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: requestedChallenge as BufferSource,
    rpId,
    userVerification: 'required',
    allowCredentials: credentialId ? [{ type: 'public-key', id: credentialId as BufferSource }] : [],
    timeout: 120_000,
  } }) as PublicKeyCredential | null;
  if (!credential) throw new Error('WEBAUTHN_ASSERTION_CANCELLED');
  if (keccak256(toHex(new Uint8Array(credential.rawId))).toLowerCase() !== expectedCredentialIdCommitment.toLowerCase()) {
    throw new Error('WEBAUTHN_WRONG_CREDENTIAL');
  }
  const response = credential.response as AuthenticatorAssertionResponse;
  const clientDataBytes = new Uint8Array(response.clientDataJSON);
  const clientDataJSON = new TextDecoder('utf-8', { fatal: true }).decode(clientDataBytes);
  const data = JSON.parse(clientDataJSON) as { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown };
  const challengeText = base64url(requestedChallenge);
  if (data.type !== 'webauthn.get' || data.challenge !== challengeText || data.origin !== window.location.origin || data.crossOrigin === true) {
    throw new Error('WEBAUTHN_CLIENT_DATA_MISMATCH');
  }
  const challengeIndex = byteOffsetOf(clientDataBytes, `"challenge":"${challengeText}"`);
  const typeIndex = byteOffsetOf(clientDataBytes, '"type":"webauthn.get"');
  if (challengeIndex < 0 || typeIndex < 0) throw new Error('WEBAUTHN_CLIENT_DATA_ENCODING_UNSUPPORTED');
  const authenticatorData = new Uint8Array(response.authenticatorData);
  if (authenticatorData.length < 37 || (authenticatorData[32] & 0x05) !== 0x05) throw new Error('WEBAUTHN_USER_VERIFICATION_REQUIRED');
  if (toHex(authenticatorData.slice(0, 32)).toLowerCase() !== sha256(toBytes(rpId)).toLowerCase()) {
    throw new Error('WEBAUTHN_RP_ID_HASH_MISMATCH');
  }
  const { r, s } = parseP256DerSignature(new Uint8Array(response.signature));
  return { r, s, challengeIndex, typeIndex, authenticatorData: toHex(authenticatorData), clientDataJSON };
}
