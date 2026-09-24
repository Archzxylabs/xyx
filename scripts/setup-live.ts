/**
 * Interactive, read-only network setup for the XYX Monad Testnet release path.
 *
 * It may create `.env` from `.env.example`, but never deploys, signs, broadcasts,
 * reads a private key, accesses a faucet, or accepts credential-bearing RPC URLs.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { normalizeEndpoint, redactRpcUrl } from '../packages/monad/src/deployment-readiness';

const ENV_FILE = '.env';
const TEMPLATE_FILE = '.env.example';
const EXPECTED_CHAIN_ID = 10143;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function usage(): never {
  stdout.write([
    'Usage: npm run setup:live',
    '',
    'Prompts for two distinct public RPC URLs, a WebAuthn RP ID, and a token',
    'candidate. It verifies both nodes are Monad Testnet and checks token code,',
    'decimals() = 6, and symbol() before creating .env from .env.example.',
    'It never deploys, broadcasts, signs, reads keys, or calls a faucet.',
    '',
  ].join('\n'));
  process.exit(0);
}

function validatePublicRpc(value: string): string {
  try {
    const url = new URL(value.trim());
    const local = url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if ((!local && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('PUBLIC_RPC_URL_UNSAFE');
    }
    return url.toString().replace(/\/$/, '');
  } catch (error) {
    if (error instanceof Error && error.message === 'PUBLIC_RPC_URL_UNSAFE') throw error;
    throw new Error('PUBLIC_RPC_URL_INVALID');
  }
}

function validateRpId(value: string): string {
  const rpId = value.trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(rpId)) return rpId;
  throw new Error('RP_ID_INVALID');
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('RPC_UNREACHABLE');
  }
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('RPC_RESPONSE_INVALID'); }
  if (!response.ok || !body || typeof body !== 'object' || Array.isArray(body)) throw new Error('RPC_RESPONSE_INVALID');
  const record = body as { result?: unknown; error?: unknown };
  if (record.error || typeof record.result !== 'string') throw new Error('RPC_CALL_FAILED');
  return record.result;
}

function decodeQuantity(value: string): bigint {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) throw new Error('RPC_QUANTITY_MALFORMED');
  return BigInt(value);
}

function decodeAbiUint256(word: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(word)) throw new Error('TOKEN_CALL_MALFORMED');
  return BigInt(word);
}

function decodeSymbol(data: string): string {
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 66) throw new Error('TOKEN_SYMBOL_MALFORMED');
  const bytes = Buffer.from(data.slice(2), 'hex');
  // Most ERC-20s return ABI dynamic string; accept bytes32 only for legacy tokens.
  if (bytes.length === 32) return bytes.toString('utf8').replace(/\0+$/, '');
  const offset = Number(BigInt(`0x${bytes.subarray(0, 32).toString('hex')}`));
  if (offset !== 32 || bytes.length < 64) throw new Error('TOKEN_SYMBOL_MALFORMED');
  const length = Number(BigInt(`0x${bytes.subarray(32, 64).toString('hex')}`));
  if (!Number.isSafeInteger(length) || length < 1 || length > 64 || bytes.length < 64 + length) throw new Error('TOKEN_SYMBOL_MALFORMED');
  return bytes.subarray(64, 64 + length).toString('utf8');
}

function setEnv(template: string, updates: Record<string, string>): string {
  const present = new Set<string>();
  const lines = template.split(/\r?\n/).map(line => {
    const match = /^([A-Z0-9_]+)=.*$/.exec(line);
    if (!match || updates[match[1]] === undefined) return line;
    present.add(match[1]);
    return `${match[1]}=${updates[match[1]]}`;
  });
  for (const [key, value] of Object.entries(updates)) if (!present.has(key)) lines.push(`${key}=${value}`);
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) usage();
  if (existsSync(ENV_FILE)) throw new Error('ENV_ALREADY_EXISTS: refuse to read or overwrite an existing .env; edit it manually or move it aside first');
  if (!existsSync(TEMPLATE_FILE)) throw new Error('ENV_TEMPLATE_MISSING');
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('INTERACTIVE_TTY_REQUIRED');

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const primary = validatePublicRpc(await prompt.question('Primary public Monad Testnet RPC URL: '));
    const secondary = validatePublicRpc(await prompt.question('Independent secondary public Monad Testnet RPC URL: '));
    const rpId = validateRpId(await prompt.question('WebAuthn RP ID (bare public host, for example app.example.com): '));
    const token = (await prompt.question('Monad Testnet token candidate address (must report 6 decimals): ')).trim();
    if (!ADDRESS.test(token) || /^0x0{40}$/i.test(token)) throw new Error('TOKEN_ADDRESS_INVALID');
    if (normalizeEndpoint(primary) === normalizeEndpoint(secondary)) throw new Error('RPC_ENDPOINTS_NOT_DISTINCT');

    const [primaryChain, secondaryChain] = await Promise.all([rpc(primary, 'eth_chainId'), rpc(secondary, 'eth_chainId')]);
    if (decodeQuantity(primaryChain) !== BigInt(EXPECTED_CHAIN_ID) || decodeQuantity(secondaryChain) !== BigInt(EXPECTED_CHAIN_ID)) {
      throw new Error('RPC_WRONG_CHAIN');
    }
    const [codeA, codeB, decimalsA, decimalsB, symbolA, symbolB] = await Promise.all([
      rpc(primary, 'eth_getCode', [token, 'finalized']), rpc(secondary, 'eth_getCode', [token, 'finalized']),
      rpc(primary, 'eth_call', [{ to: token, data: '0x313ce567' }, 'finalized']), rpc(secondary, 'eth_call', [{ to: token, data: '0x313ce567' }, 'finalized']),
      rpc(primary, 'eth_call', [{ to: token, data: '0x95d89b41' }, 'finalized']), rpc(secondary, 'eth_call', [{ to: token, data: '0x95d89b41' }, 'finalized']),
    ]);
    if (codeA === '0x' || codeA.toLowerCase() !== codeB.toLowerCase()) throw new Error('TOKEN_CODE_MISMATCH');
    if (decodeAbiUint256(decimalsA) !== 6n || decimalsA.toLowerCase() !== decimalsB.toLowerCase()) throw new Error('TOKEN_DECIMALS_MISMATCH');
    const symbol = decodeSymbol(symbolA);
    if (!symbol || symbol !== decodeSymbol(symbolB)) throw new Error('TOKEN_SYMBOL_MISMATCH');

    const template = readFileSync(TEMPLATE_FILE, 'utf8');
    writeFileSync(ENV_FILE, setEnv(template, {
      XYX_RPC_URL: primary, XYX_PRIMARY_RPC_URL: primary, XYX_SECONDARY_RPC_URL: secondary,
      NEXT_PUBLIC_XYX_RPC_URL: primary, NEXT_PUBLIC_XYX_SECONDARY_RPC_URL: secondary,
      XYX_RP_ID: rpId, NEXT_PUBLIC_XYX_RP_ID: rpId,
      MONAD_USDC_ADDRESS: token, XYX_PAYMENT_TOKEN_ADDRESS: token, NEXT_PUBLIC_XYX_PAYMENT_TOKEN_ADDRESS: token,
    }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    stdout.write(`CONFIG_WRITTEN_NO_DEPLOYMENT\nchainId=${EXPECTED_CHAIN_ID}\nprimary=${redactRpcUrl(primary)}\nsecondary=${redactRpcUrl(secondary)}\ntoken=${token}\nsymbol=${symbol}\ndecimals=6\n`);
    stdout.write('Next: review the uncommitted source, then run npm run readiness. A ready report is still not authorization to deploy.\n');
  } finally { prompt.close(); }
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'SETUP_FAILED';
  process.stderr.write(`SETUP_LIVE_FAILED: ${message}\n`);
  process.exit(1);
});
