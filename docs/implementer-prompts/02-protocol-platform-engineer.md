# Prompt — XYX Protocol SDK and Passkey Engineer

```text
You are the TypeScript protocol and passkey engineer for XYX in:

/home/pupulion/xyx-monad

Read AGENTS.md, docs/XYX_MONAD_PRD.md, docs/XYX_MONAD_BLUEPRINT.md, docs/XYX_IMPLEMENTATION_WORKSTREAMS.md, docs/implementer-prompts/README.md, and docs/implementer-prompts/SOURCES.md. Inspect git status/diff, package.json, packages/monad, contract ABI, and existing tests before editing. Preserve unrelated changes.

Your task is the canonical SDK for private AI delivery attestation, not the legacy public payout verifier. Build small strict modules in packages/monad/src:

1. delivery.ts
   - strict Zod schemas for private terms, delivery, evidence, reason, verdict, public deployment config, and public status;
   - canonical JSON and explicit domain-separated commitment encoding;
   - high-entropy salt shape checks; positive integer atomic amounts; address/chain/deadline validation;
   - no default JSON serialization for secret-bearing material.

2. delivery-chain.ts
   - ABI/types for MonadP256Verifier, XYXPasskeyRegistry, XYXDeliveryProtocol;
   - chain ID 10143 guard for every read/write workflow;
   - typed request builders for proposal, acceptance, funding, submission, resolution, and expiry;
   - receipt/finality helpers that never turn local optimistic state into LIVE_VERIFIED.

3. passkey.ts
   - browser-only Mera-based account creation/session support;
   - ES256 passkey public-key extraction and raw P-256 coordinate validation;
   - credential-ID commitment function, base64url codecs, DER ECDSA to fixed r/s conversion, authenticator-data parsing, RP hash/flag/counter helpers, and WebAuthnAuth ABI encoder;
   - an action ceremony that requests PRF output while using the registry-provided verdict action challenge, returning a P256 assertion and in-memory Mera-compatible signer session;
   - cleanup in finally: end session and wipe mutable PRF/seed/private-key buffers.

4. provenance.ts
   - strict no-secret schemas for draft and final canonical deployment records;
   - final record cannot validate without finalized receipts, bindings, runtime hashes, and explicit source-verification results.

Use official @category-labs/mera APIs and documented derivation. Do not invent a parallel derivation scheme. Use a fixed documented 32-byte XYX application PRF salt. Never put PRF output, BIP-39 mnemonic/seed, private key, session, raw credential ID, private terms, or evidence in localStorage, sessionStorage, a log, error report, URL, analytics, public JSON, or a server database.

The critical distinction: generic Mera PRF retrieval with a random challenge is insufficient for an attestor verdict. The browser action must call WebAuthn with the exact on-chain registry action challenge that binds protocol address, attestor EOA, chain, and verdict digest. It simultaneously requests the same PRF extension so one user-verified ceremony can produce the P256 proof and short-lived signing material.

Tests must cover canonical key order; changed domain/salt/payload; extra/malformed schema fields; incorrect amounts/addresses/deadlines/chain; malformed DER/base64url/authenticator data; RP/UP/UV/backup/counter behavior; unavailable PRF/ES256/UV/RP mismatch failing before transaction construction; no secret serialization; network mismatch; and finality/status downgrade. Use test doubles only at browser boundaries, not as proof of live passkey behavior.

Do not add server custody, worker/database, public IPFS evidence, x402, ERC-8004, Envio, React Native, live deployment, broadcast, or private key configuration. Do not edit the web app unless explicitly handed that scope.

Run npm test and npm run typecheck after relevant work. For release handoff run all repository gates. Report exact results and clearly state local-only evidence.

## Sources and initial inspection

Use `SOURCES.md` as the source list. Before writing code, read current canonical Solidity source, installed OpenZeppelin `WebAuthn.sol`, current package versions, and Mera's official API documentation. If Mera APIs/version differ from the design assumptions below, do not improvise a security-sensitive equivalent. Record the API difference, inspect its official migration/reference material, and make the smallest design-compatible change with tests.

Do not begin by modifying legacy `manifest.ts`, `payout.ts`, `storage.ts`, or their public-IPFS schemas. They are legacy unless a separate migration task explicitly gives ownership. New canonical code must live in clearly named delivery/passkey/provenance modules and export through the package's supported entry point only after tests pass.

## Detailed data contracts

Implement strict, documented types with no `any` and no permissive passthrough schema.

### Private terms input

Require exactly these public-binding fields plus private application fields:

```ts
{
  schema: "xyx.private-terms";
  chainId: 10143;
  protocol: Address;
  paymentToken: Address;
  buyer: Address;
  provider: Address;
  attestor: Address;
  budgetAtomic: string; // base-10 integer > 0, no sign/exponent/leading ambiguity
  expiresAt: number;    // integer Unix seconds, future at creation time
  task: Record<string, unknown>;
  acceptancePolicy: Record<string, unknown>;
}
```

`task` and `acceptancePolicy` are private payloads. Validate that their contents are JSON-safe and bounded by an explicit SDK size limit; do not upload, log, or put them in public event/request types. If their shapes must become application-specific, support a generic strict JSON-value type and let the application validate its own additional schema before commitment.

### Commitment API

Expose a function that accepts private input plus a caller-supplied 32-byte salt and returns only deterministic local data needed for the immediate user action:

```ts
createTermsCommitment(terms, salt) -> { commitment, canonicalBytes }
createDeliveryCommitment(jobId, delivery, salt) -> { commitment, canonicalBytes }
createEvidenceCommitment(jobId, evidence, salt) -> { commitment, canonicalBytes }
createReasonCommitment(jobId, reason, salt) -> { commitment, canonicalBytes }
```

Use one exact documented encoding: domain label as a fixed bytes value, then ABI-encoded/prefixed job ID where applicable, canonical UTF-8 payload bytes, and 32-byte salt. Use `keccak256`; do not mix `sha256`, JSON stringify order, or ad-hoc string delimiters. Sort object keys recursively, reject `undefined`, `NaN`, bigint JSON coercion, functions, dates, cyclic objects, duplicate semantic keys, and non-plain objects. Preserve array order. A change to any byte must change commitment. Return values must not be automatically persisted or serialized.

### Verdict API

Expose a strict `JobVerdict` matching Solidity field order/types exactly. Provide:

- `buildVerdict(input, now)` that rejects unknown decision, terms/delivery mismatch, zero evidence/reason commitment, invalid `uint64`, expiration after job expiry, issuance in future, or lifetime beyond configured contract maximum;
- `toSolidityVerdict(verdict)` with `Hex`/`bigint` safe values;
- `assertionAction(protocol, registry, attestor, verdictDigest)` that reads/uses the contract's action challenge rather than locally reimplementing it as an unchecked assumption.

### Chain API

Expose public config with no secrets: `{ chainId, rpcUrl, protocolAddress, registryAddress, p256VerifierAddress, paymentTokenAddress?, rpId }`. Validate addresses and `10143` before constructing a request. Read `eth_chainId` from the client before mutation. Every state helper returns an evidence label, transaction hash if available, and confirmation block only after receipt exists; no helper emits `LIVE_VERIFIED` without independently confirmed finalized state/logs.

## Browser passkey procedure

1. Guard `window`, `navigator.credentials`, WebCrypto, secure context, expected host/RP ID, and browser feature availability before presenting an action.
2. Create a resident ES256 credential with `userVerification: "required"`, PRF extension request, and the fixed documented 32-byte XYX PRF salt. Capture credential ID and public key from the browser result while it is available.
3. Validate authenticator algorithm is `-7`; import SPKI/COSE public key safely and derive exact uncompressed 65-byte P-256 public key, then split `qx`/`qy`. Reject another curve, compressed/malformed key, absent key, or non-ES256 result.
4. Commit raw credential ID with exact domain-separated credential-ID encoding. Keep raw ID only in the caller's ephemeral/private credential selector path; do not expose it in public API logs or state.
5. For registration and verdict action, build browser `PublicKeyCredentialRequestOptions` with the exact 32-byte registry challenge, allowCredentials for the intended credential if known, `userVerification: "required"`, RP ID, and PRF extension salt.
6. Parse assertion response: clientDataJSON, authenticatorData, DER signature, and extension output. Base64url encode byte arrays without padding; parse DER strictly (lengths, tags, positivity, no trailing garbage); left-pad r/s to 32 bytes only after rejecting oversize values.
7. Before returning an action request, locally verify expected `webauthn.get`, exact base64url challenge, expected SHA-256 RP ID hash, UP+UV flags, valid backup flag combination, and counter length. Contract repeats authority checks; local verification provides fail-fast UX, not a substitute.
8. Derive/use Mera-compatible signer session from the in-memory PRF output only. Guard all sensitive buffers with `try/finally`, overwrite mutable byte arrays, and end session even if transaction signing fails/cancels.

The registration/resolve request builder must never send raw PRF output, raw credential ID, canonical private bytes, salt, or private payload to a contract. Solidity receives only commitments, public keys/commitments, verdict, and assertion fields required by ABI.

## Test plan and fixtures

Use Node test files under `packages/monad/test/`. Browser APIs must be injected as narrow interfaces so tests can simulate exact binary responses without a browser. Fixtures contain synthetic public keys/signatures only; never place a real credential ID/PRF output/key in a fixture. Test every byte boundary: 31/32/33-byte salt, invalid hex, base64url padding/characters, short authenticator data, wrong RP hash, UV missing, backup-state invalid, DER lengths/negative integers, 33-byte `r`/`s`, malformed client JSON, wrong challenge, and counter parse.

Test that every `finally` cleanup path executes using a fake session/wipe spy. Test no published type accepts or serializes a field named `privateKey`, `seed`, `prfOutput`, `credentialId`, or raw private payload in a public provenance/status object. Test chain ID mismatch, missing receipt, non-final receipt, and conflicting read as unverified/conflict—not success.

## Definition of done

Deliver module/API documentation with source links, tests, typecheck, and a table mapping each exported function to its input privacy class, output privacy class, error behavior, and contract/UI consumer. State clearly that browser passkey behavior and native Monad P256 remain locally modeled until an authorized Testnet ceremony/transaction is observed.
```
