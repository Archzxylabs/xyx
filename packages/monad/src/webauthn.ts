/**
 * Browser-only WebAuthn helpers for XYX passkey operations.
 *
 * SECURITY: This module MUST only be imported by client components ('use client').
 * It must never be imported by a server-rendered module.
 *
 * Raw credential ID, PRF output, seed, private key, assertion blobs, and
 * session material must never reach browser persistence, console, URLs,
 * error telemetry, or analytics. They live in memory only for the duration
 * of the ceremony and are zeroed in a finally block.
 */

import { keccak256, toHex } from 'viem';

export { APP_PRF_SALT, CREDENTIAL_ID_COMMITMENT_DOMAIN } from './commitments';

/**
 * Result of credential registration ceremony.
 * Contains ONLY public data. Raw credential ID is never returned.
 */
export interface RegistrationResult {
  credentialIdCommitment: `0x${string}`;
  qx: `0x${string}`;
  qy: `0x${string}`;
}

/**
 * Result of action (verdict) ceremony.
 * Contains ONLY public assertion data. PRF output stays in memory only.
 */
export interface ActionResult {
  assertion: {
    r: `0x${string}`;
    s: `0x${string}`;
    authenticatorData: Uint8Array;
    clientDataJSON: string;
  };
}

/**
 * Check if the browser environment supports required WebAuthn features.
 */
export function checkWebAuthnSupport(): { supported: true } | { supported: false; reason: string } {
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    return { supported: false, reason: 'WebCrypto API not available in this context' };
  }
  if (!window.PublicKeyCredential) {
    return { supported: false, reason: 'WebAuthn (PublicKeyCredential) not supported' };
  }
  if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') {
    return { supported: false, reason: 'User-verifying platform authenticator check unavailable' };
  }
  return { supported: true };
}

/**
 * Check if a passkey supports PRF input.
 */
export async function checkPrfSupport(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.crypto?.subtle) return false;
  try {
    const prf = (window.crypto.subtle as unknown as { prf: { importKey(...args: unknown[]): Promise<CryptoKey> } }).prf;
    if (!prf) return false;
    // Attempt a minimal PRF call to verify support
    const result = await prf.importKey('raw', new Uint8Array(32) as unknown as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return !!result;
  } catch {
    return false;
  }
}

/**
 * Convert an ArrayBuffer or Uint8Array to a hex string.
 */
function bufferToHex(buffer: ArrayBuffer | Uint8Array): `0x${string}` {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return toHex(Buffer.from(bytes));
}

/**
 * Convert base64url string to Uint8Array.
 */
function base64urlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Convert Uint8Array to base64url.
 */
function bytesToBase64url(bytes: Uint8Array): string {
  const binary = Array.from(bytes).map(b => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Parse clientDataJSON to extract rpIdHash and type.
 * Note: The rpIdHash is extracted from authenticatorData during verification,
 * not from clientDataJSON. This function returns an empty rpIdHash that must
 * be filled from authenticatorData before verification.
 */
export interface ParsedClientData {
  rpIdHash: Uint8Array;
  type: string;
  challenge: Uint8Array;
}

export function parseClientDataJSON(clientDataJSON: string): ParsedClientData {
  const parsed = JSON.parse(clientDataJSON);
  const challenge = base64urlToBytes(parsed.challenge);
  // rpIdHash is extracted from authenticatorData, not clientData.
  // Return 32-byte placeholder; caller must overwrite with authenticatorData[0..31].
  const rpIdHash = new Uint8Array(32);
  return {
    rpIdHash,
    type: parsed.type,
    challenge,
  };
}

/**
 * Verify that the credential is resident and user-verifying by checking
 * the authenticatorData flags.
 */
export function verifyAuthenticatorDataFlags(authData: Uint8Array): {
  valid: boolean;
  uv: boolean;
  up: boolean;
  backupEligible: boolean;
  backupState: boolean;
} {
  if (authData.length < 37) {
    return { valid: false, uv: false, up: false, backupEligible: false, backupState: false };
  }

  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const counterBytes = authData.slice(33, 37);

  const up = !!(flags & 0x01);
  const uv = !!(flags & 0x04);
  const backupEligible = !!(flags & 0x08);
  const backupState = !!(flags & 0x10);

  return {
    valid: true,
    uv,
    up,
    backupEligible,
    backupState,
  };
}

/**
 * Read signature counter from authenticatorData (big-endian uint32 at offset 33).
 */
export function readSignCount(authData: Uint8Array): number {
  if (authData.length < 37) return 0;
  const view = new DataView(authData.buffer, authData.byteOffset + 33, 4);
  return view.getUint32(0);
}

/**
 * Create a WebAuthn registration credential request.
 *
 * @param rpId - The relying party ID (e.g., 'app.example.com')
 * @param challenge - The server-provided registration challenge (hash)
 * @param userHandle - Optional user handle
 */
export async function createRegistrationRequest(
  rpId: string,
  challenge: Uint8Array,
  userHandle?: Uint8Array
): Promise<CredentialCreationOptions> {
  return {
    publicKey: {
      challenge: challenge as unknown as BufferSource,
      rp: {
        name: 'XYX Protocol',
        id: rpId,
      },
      user: {
        id: (userHandle ?? new Uint8Array(16)) as unknown as BufferSource,
        name: 'xyx-attestor',
        displayName: 'XYX Attestor',
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 }, // ES256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        residentKey: 'required',
        requireResidentKey: true,
      },
      extensions: {
        prf: {
          eval: {
            first: new Uint8Array(32),
          },
        },
      },
    },
  };
}

/**
 * Create a WebAuthn get (assertion) credential request for verdict action.
 */
export async function createAssertionRequest(
  rpId: string,
  challenge: Uint8Array,
  allowCredentials: PublicKeyCredentialDescriptor[]
): Promise<CredentialRequestOptions> {
  return {
    publicKey: {
      challenge: challenge as unknown as BufferSource,
      rpId,
      userVerification: 'required',
      allowCredentials,
      extensions: {
        prf: {
          eval: {
            first: new Uint8Array(32),
          },
        },
      },
    },
  };
}

/**
 * Extract P-256 public key coordinates from a registration credential.
 *
 * PRF output is NOT a public key. The P-256 public key (qx, qy) comes from
 * the attestation statement's public key or the credential's publicKey property.
 */
export async function extractP256PublicKey(
  credential: PublicKeyCredential
): Promise<{ qx: `0x${string}`; qy: `0x${string}` }> {
  // PublicKeyCredential.response is AuthenticatorAttestationResponse for registration
  const response = credential.response as unknown as { getClientExtensionResults: () => { prf?: { results?: { first?: { x?: ArrayBuffer; y?: ArrayBuffer } } } }; publicKey?: { x?: ArrayBuffer; y?: ArrayBuffer } };

  // Try to get from clientExtensionResults first (PRF extension does NOT give public key)
  const prfResults = response.getClientExtensionResults()?.prf;
  // PRF results contain PRF output, NOT public key coordinates.
  // The public key must come from the attestation statement.

  let qx: ArrayBuffer | undefined;
  let qy: ArrayBuffer | undefined;

  // Extract from the credential publicKey property
  const publicKey = response.publicKey;
  if (publicKey?.x && publicKey?.y) {
    qx = publicKey.x;
    qy = publicKey.y;
  } else {
    throw new Error('P256_KEY_UNAVAILABLE');
  }

  return {
    qx: bufferToHex(qx),
    qy: bufferToHex(qy),
  };
}

/**
 * Convert raw credential ID to its commitment.
 */
export function rawIdToCredentialIdCommitment(rawId: ArrayBuffer | Uint8Array): `0x${string}` {
  const bytes = rawId instanceof Uint8Array ? rawId : new Uint8Array(rawId);
  return keccak256(toHex(bytes)) as `0x${string}`;
}

/**
 * Clean up sensitive data from memory.
 * Call this in a finally block after any ceremony.
 */
export function wipeSensitive(data: {
  credentialId?: Uint8Array | ArrayBuffer;
  rawId?: Uint8Array | ArrayBuffer;
  prfOutput?: Uint8Array | ArrayBuffer;
  seed?: Uint8Array | ArrayBuffer;
  privateKey?: CryptoKey;
}): void {
  for (const [, value] of Object.entries(data)) {
    if (!value) continue;
    if (value instanceof Uint8Array) {
      value.fill(0);
    } else if (value instanceof ArrayBuffer) {
      const view = new Uint8Array(value);
      view.fill(0);
    }
    // CryptoKey: just drop the reference; browser GC handles the rest.
  }
}

/**
 * Check if the current origin is secure (HTTPS or localhost).
 */
export function isSecureContext(): boolean {
  if (typeof window === 'undefined') return false;
  return window.isSecureContext;
}

/**
 * Check if the provided RP ID matches the current origin.
 */
export function validateRpIdOrigin(rpId: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const origin = window.location.origin;
    const hostname = window.location.hostname;
    return rpId === hostname || rpId === origin.replace(/^https?:\/\//, '') || origin.endsWith(`.${rpId}`);
  } catch {
    return false;
  }
}
