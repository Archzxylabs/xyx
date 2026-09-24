import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { hexToBytes } from 'viem';
import { byteOffsetOf, parseP256DerSignature } from '../src/native-passkey';

test('real ES256 DER signatures decode to the same P1363 r/s and verify', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const message = Buffer.from('XYX passkey ABI parity');
  for (let attempt = 0; attempt < 32; attempt++) {
    const der = sign('sha256', message, { key: privateKey, dsaEncoding: 'der' });
    const { r, s } = parseP256DerSignature(der);
    const p1363 = Buffer.concat([Buffer.from(hexToBytes(r)), Buffer.from(hexToBytes(s))]);
    assert.equal(p1363.length, 64);
    assert.equal(verify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, p1363), true);
  }
});

test('malformed DER is rejected', () => {
  assert.throws(() => parseP256DerSignature(new Uint8Array()), /WEBAUTHN_SIGNATURE_DER_INVALID/);
  assert.throws(() => parseP256DerSignature(Uint8Array.of(0x30, 0x02, 0x02, 0x00)), /WEBAUTHN_SIGNATURE_DER_INVALID/);
});

test('WebAuthn indices are UTF-8 byte offsets even when JSON contains non-ASCII text', () => {
  const text = '{"label":"é","type":"webauthn.get","challenge":"AQID"}';
  const bytes = new TextEncoder().encode(text);
  assert.equal(byteOffsetOf(bytes, '"type":"webauthn.get"'), text.indexOf('"type":"webauthn.get"') + 1);
  assert.equal(byteOffsetOf(bytes, '"challenge":"AQID"'), text.indexOf('"challenge":"AQID"') + 1);
  assert.equal(byteOffsetOf(bytes, 'not present'), -1);
});
