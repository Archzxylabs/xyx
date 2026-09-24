/**
 * XYX Canonical Passkey Module
 *
 * Browser-only passkey account creation and session management using
 * @category-labs/mera. ES256 P-256 key extraction, DER ECDSA signature
 * parsing, base64url codecs, authenticator-data parsing, and the action
 * ceremony for on-chain registry challenges.
 *
 * SECURITY: Credential metadata, PRF outputs, and secret material are
 * never serialized to disk. Cleanup in finally blocks.
 *
 * @module @xyx/monad/passkey
 */

import { APP_PRF_SALT } from './commitments';

// ===========================================================================
// Base64url codec (WebAuthn standard encoding)
// ===========================================================================

export function toBase64url(bytes: Uint8Array): string {
  const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * WebAuthn credential transport types.
 */
export type CredentialTransport = 'hybrid' | 'internal' | 'usb' | 'nfc' | 'ble';

export function fromBase64url(str: string): Uint8Array {
  const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = normalized.length % 4;
  const padded = padLen === 0 ? normalized : normalized + '===='.slice(padLen);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

// ===========================================================================
// DER ECDSA to r/s conversion
// ===========================================================================

export function derEcdsaToRS(derSig: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  if (derSig.length < 8) {
    throw new Error('DER_TOO_SHORT: DER signature too short');
  }
  if (derSig[0] !== 0x30) {
    throw new Error('DER_INVALID: expected SEQUENCE tag 0x30');
  }

  const totalLen = derSig[1];
  if (derSig.length !== 2 + totalLen) {
    throw new Error('DER_INVALID_LENGTH: declared length does not match actual');
  }

  let offset = 2;

  if (derSig[offset] !== 0x02) {
    throw new Error('DER_INVALID_R: expected INTEGER tag 0x02');
  }
  const rLen = derSig[offset + 1];
  offset += 2;
  if (rLen > 32 || rLen === 0) {
    throw new Error('DER_INVALID_R_LENGTH: r length must be 1-32');
  }
  const r = new Uint8Array(32);
  const rStart = 32 - rLen;
  for (let i = 0; i < rLen; i++) {
    r[rStart + i] = derSig[offset + i];
  }
  offset += rLen;

  if (derSig[offset] !== 0x02) {
    throw new Error('DER_INVALID_S: expected INTEGER tag 0x02');
  }
  const sLen = derSig[offset + 1];
  offset += 2;
  if (sLen > 32 || sLen === 0) {
    throw new Error('DER_INVALID_S_LENGTH: s length must be 1-32');
  }
  const s = new Uint8Array(32);
  const sStart = 32 - sLen;
  for (let i = 0; i < sLen; i++) {
    s[sStart + i] = derSig[offset + i];
  }

  if (offset !== derSig.length) {
    throw new Error('DER_TRAILING_BYTES: DER signature has trailing bytes');
  }

  return { r, s };
}

export function derEcdsaToConcatRS(derSig: Uint8Array): Uint8Array {
  const { r, s } = derEcdsaToRS(derSig);
  const result = new Uint8Array(64);
  result.set(r, 0);
  result.set(s, 32);
  return result;
}

// ===========================================================================
// P-256 public key extraction from COSE to hex
// ===========================================================================

export function p256PublicKeyToHex(x: Uint8Array, y: Uint8Array): string {
  if (x.length !== 32 || y.length !== 32) {
    throw new Error(`INVALID_P256_COORDINATES: x=${x.length}, y=${y.length}`);
  }
  const point = new Uint8Array(65);
  point[0] = 0x04;
  point.set(x, 1);
  point.set(y, 33);
  return '0x' + Array.from(point, b => b.toString(16).padStart(2, '0')).join('');
}

// ===========================================================================
// Authenticator data parsing
// ===========================================================================

export interface ParsedAuthenticatorData {
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  credentialId?: Uint8Array;
  credentialPublicKey?: Uint8Array;
}

export function parseAuthenticatorData(data: Uint8Array): ParsedAuthenticatorData {
  if (data.length < 37) {
    throw new Error(`AUTH_DATA_TOO_SHORT: ${data.length} bytes, need at least 37`);
  }

  const rpIdHash = data.slice(0, 32);
  const flags = data[32];
  const counter = (data[33] << 24) | (data[34] << 16) | (data[35] << 8) | data[36];

  const result: ParsedAuthenticatorData = {
    rpIdHash,
    flags,
    counter,
  };

  const hasAttestedCredentialData = Boolean(flags & 0x40);
  let offset = 37;

  if (hasAttestedCredentialData) {
    if (data.length < offset + 18) {
      throw new Error('AUTH_DATA_TOO_SHORT: not enough room for attested credential data');
    }
    offset += 16;

    const credIdLen = (data[offset] << 8) | data[offset + 1];
    offset += 2;

    if (data.length < offset + credIdLen) {
      throw new Error('AUTH_DATA_TOO_SHORT: not enough room for credential ID');
    }

    result.credentialId = data.slice(offset, offset + credIdLen);
    offset += credIdLen;
    result.credentialPublicKey = data.slice(offset);
  }

  return result;
}

export async function verifyRpIdHash(data: Uint8Array, expectedRpId: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const expectedHash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(expectedRpId))
  );
  if (data.length < 32) return false;
  return data.slice(0, 32).every((b, i) => b === expectedHash[i]);
}

export async function computeRpIdHash(rpId: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rpId));
  return new Uint8Array(hashBuffer);
}

// ===========================================================================
// Client data JSON parsing
// ===========================================================================

export interface ParsedClientDataJSON {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
}

export function parseClientDataJSON(clientDataJSON: string | Uint8Array): ParsedClientDataJSON {
  const jsonStr = typeof clientDataJSON === 'string' ? clientDataJSON
    : new TextDecoder().decode(clientDataJSON);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('INVALID_CLIENT_DATA_JSON: not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('INVALID_CLIENT_DATA_JSON: not an object');
  }

  const record = parsed as Record<string, unknown>;

  if (typeof record.type !== 'string') {
    throw new Error('INVALID_CLIENT_DATA_JSON: missing type');
  }
  if (typeof record.challenge !== 'string') {
    throw new Error('INVALID_CLIENT_DATA_JSON: missing challenge');
  }
  if (typeof record.origin !== 'string') {
    throw new Error('INVALID_CLIENT_DATA_JSON: missing origin');
  }
  if (record.crossOrigin !== undefined && typeof record.crossOrigin !== 'boolean') {
    throw new Error('INVALID_CLIENT_DATA_JSON: crossOrigin must be boolean');
  }

  return {
    type: record.type,
    challenge: record.challenge,
    origin: record.origin,
    crossOrigin: record.crossOrigin,
  };
}

// ===========================================================================
// WebAuthn support checks
// ===========================================================================

export function isWebAuthnAvailable(): boolean {
  return typeof navigator !== 'undefined'
    && typeof (navigator as Navigator & { credentials?: { create?: unknown } }).credentials !== 'undefined'
    && typeof (navigator as Navigator & { credentials?: { create: unknown } }).credentials.create === 'function';
}

export function isSecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext;
}

export function checkWebAuthnSupport(): void {
  if (!isSecureContext()) {
    throw new Error('WEB_AUTHN_UNSUPPORTED: require HTTPS or localhost');
  }
  if (!isWebAuthnAvailable()) {
    throw new Error('WEB_AUTHN_UNAVAILABLE: navigator.credentials not available');
  }
}

// ===========================================================================
// Mera-based account creation
// ===========================================================================

/**
 * Credential metadata stored after passkey creation.
 * Safe for storage — no secret material.
 */
export interface XYXPskCredential {
  credentialId: string;
  transports: string[];
  rpId: string;
  prfSalt: string;
  createdAt: number;
}

export interface CreateXYXPasskeyOptions {
  rpId: string;
  userName: string;
  displayName: string;
}

/**
 * Convert APP_PRF_SALT string to Uint8Array for Mera's prfSalt parameter.
 */
function appPrfSaltBytes(): Uint8Array {
  return new TextEncoder().encode(APP_PRF_SALT);
}

/**
 * Create a new passkey with PRF evaluation for XYX.
 */
export async function createXYXPasskey(
  options: CreateXYXPasskeyOptions
): Promise<{ credential: XYXPskCredential; prfOutput: Uint8Array }> {
  if (typeof window === 'undefined') {
    throw new Error('PASSKEY_BROWSER_ONLY: passkey operations require a browser');
  }
  checkWebAuthnSupport();

  const mera = await import('@category-labs/mera');
  const prfSalt = appPrfSaltBytes();

  const result = await mera.createPasskeyWithPrfOutput({
    rp: { id: options.rpId, name: 'XYX Protocol' },
    user: {
      name: options.userName,
      displayName: options.displayName,
    },
    prfSalt,
  });

  const credential: XYXPskCredential = {
    credentialId: result.credentialId,
    transports: result.transports ? Array.from(result.transports) : [],
    rpId: options.rpId,
    prfSalt: toBase64url(prfSalt),
    createdAt: Date.now(),
  };

  return {
    credential,
    prfOutput: new Uint8Array(result.prfOutput),
  };
}

// ===========================================================================
// Session management
// ===========================================================================

export interface XYXPskSession {
  credential: XYXPskCredential;
  prfOutput: Uint8Array;
  publicKey?: string;
  address?: string;
}

let activeSession: XYXPskSession | null = null;

export async function startXYXSession(
  credential: XYXPskCredential
): Promise<XYXPskSession> {
  if (typeof window === 'undefined') {
    throw new Error('PASSKEY_BROWSER_ONLY: passkey operations require a browser');
  }
  checkWebAuthnSupport();

  if (activeSession !== null) {
    wipeSession(activeSession);
  }

  const mera = await import('@category-labs/mera');
  const prfSalt = fromBase64url(credential.prfSalt);

  const result = await mera.getPasskeyPrfOutput({
    rpId: credential.rpId,
    credential: {
      credentialId: credential.credentialId,
      transports: credential.transports,
    },
    prfSalt,
  });

  const session: XYXPskSession = {
    credential,
    prfOutput: new Uint8Array(result.prfOutput),
  };

  activeSession = session;
  return session;
}

export function getActiveSession(): XYXPskSession | null {
  return activeSession;
}

export function wipeSession(session: XYXPskSession): void {
  session.prfOutput.fill(0);
  session.publicKey = undefined;
  session.address = undefined;
}

export function endSession(): void {
  if (activeSession !== null) {
    wipeSession(activeSession);
    activeSession = null;
  }
}

// ===========================================================================
// Credential ID commitment
// ===========================================================================

/**
 * Canonical credential-ID commitment.
 *
 * credentialIdCommitment = keccak256(rawCredentialIdBytes)
 *
 * `credentialId` is the base64url string produced by the WebAuthn ceremony.
 * It is decoded to its raw bytes (the same bytes the authenticator is asked to
 * use as the credential ID — see performActionCeremony) and hashed DIRECTLY.
 * The digest must equal what XYXPasskeyRegistry stores for the owner at
 * registration (registerCredential) and re-check at assertion (consumeAssertion
 * uses the stored value), so both sides must hash the identical raw bytes.
 *
 * Do NOT hash a hex TEXT rendering of those bytes: `keccak256(toHex(hexString))`
 * hex-encodes the UTF-8 *characters* of the hex string, yielding a digest over
 * the wrong bytes. Keep this the single canonical credential-ID commitment.
 */
export async function credentialIdToCommitment(credentialId: string): Promise<string> {
  const bytes = fromBase64url(credentialId);
  const { keccak256, toHex } = await import('viem');
  return keccak256(toHex(bytes));
}

// ===========================================================================
// Action ceremony — produce P256 assertion for on-chain registry
// ===========================================================================

export interface ActionCeremonyOptions {
  credential: XYXPskCredential;
  challenge: string;
  rpId: string;
}

export interface ActionCeremonyResult {
  authenticatorData: Uint8Array;
  clientDataJSON: string;
  signature: Uint8Array;
  credentialId: string;
}

export async function performActionCeremony(
  options: ActionCeremonyOptions
): Promise<ActionCeremonyResult> {
  if (typeof window === 'undefined') {
    throw new Error('PASSKEY_BROWSER_ONLY: passkey operations require a browser');
  }
  checkWebAuthnSupport();

  const challengeBytes = fromBase64url(options.challenge);

  // Use type assertion to avoid redeclaring navigator types
  const credContainer = (navigator as Navigator & { credentials: { get: (opts: unknown) => Promise<PublicKeyCredential | null> } }).credentials;
  const assertionResult = await credContainer.get({
    publicKey: {
      challenge: challengeBytes as BufferSource,
      rpId: options.rpId,
      userVerification: 'required',
      allowCredentials: [
        {
          id: fromBase64url(options.credential.credentialId) as BufferSource,
          type: 'public-key',
          transports: options.credential.transports as CredentialTransport[],
        },
      ],
    },
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = (assertionResult as any)?.response as
    | { authenticatorData: ArrayBuffer; clientDataJSON: ArrayBuffer; signature: ArrayBuffer }
    | undefined;

  if (!response) {
    throw new Error('PASSKEY_OPERATION_FAILED: assertion response is missing');
  }

  const authenticatorData = new Uint8Array(response.authenticatorData);
  const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);

  const parsed = parseClientDataJSON(clientDataJSON);
  if (parsed.challenge !== options.challenge) {
    throw new Error('ASSERTION_CHALLENGE_MISMATCH: challenge in clientDataJSON does not match');
  }
  if (parsed.type !== 'webauthn.get') {
    throw new Error(`INVALID_CLIENT_DATA_TYPE: expected "webauthn.get", got "${parsed.type}"`);
  }

  const derSignature = new Uint8Array(response.signature);
  const concatRS = derEcdsaToConcatRS(derSignature);

  return {
    authenticatorData,
    clientDataJSON,
    signature: concatRS,
    credentialId: options.credential.credentialId,
  };
}

// ===========================================================================
// RP ID and origin validation
// ===========================================================================

export function validateRpIdOrigin(rpId: string): void {
  if (typeof window === 'undefined') return;

  const origin = window.location.origin;
  const hostname = window.location.hostname;

  if (hostname === rpId) return;
  if (hostname === 'localhost' && rpId === 'localhost') return;
  if (hostname.endsWith('.' + rpId)) return;

  throw new Error(
    `RP_ID_ORIGIN_MISMATCH: RP ID "${rpId}" does not match origin "${origin}". ` +
    `The passkey RP ID must match the origin's hostname.`
  );
}

// ===========================================================================
// Authenticator data flag parsing
// ===========================================================================

export interface AuthenticatorFlags {
  up: boolean;
  uv: boolean;
  at: boolean;
  ed: boolean;
}

export function parseAuthenticatorFlags(flags: number): AuthenticatorFlags {
  return {
    up: Boolean(flags & 0x01),
    uv: Boolean(flags & 0x04),
    at: Boolean(flags & 0x40),
    ed: Boolean(flags & 0x80),
  };
}

export function readSignCount(data: Uint8Array): number {
  if (data.length < 37) return 0;
  return (data[33] << 24) | (data[34] << 16) | (data[35] << 8) | data[36];
}

// ===========================================================================
// Secure cleanup
// ===========================================================================

export function wipeBytes(arr: Uint8Array): void {
  arr.fill(0);
}

export function wipeAll(...arrays: Uint8Array[]): void {
  for (const arr of arrays) {
    arr.fill(0);
  }
}
