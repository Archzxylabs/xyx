/**
 * Non-broadcast deployment-readiness dry run (C0 task C).
 *
 * Prints a redacted, machine-readable JSON report and exits non-zero unless
 * every preflight check passes. It reports
 * `READY_FOR_EXPLICIT_BROADCAST_AUTHORIZATION` — never an authorization — and
 * the human still has to authorize any broadcast explicitly.
 *
 * This script CANNOT change state. It does not call `sendTransaction`,
 * `sendRawTransaction`, `cast send`, `forge script --broadcast`,
 * `cast wallet import`, or any faucet endpoint. Two SEPARATE viem clients are
 * built — one per configured RPC endpoint — and each is only ever issued
 * read-only `eth_chainId` / `eth_getCode` / `eth_call` requests. An `--offline`
 * run builds no client at all and can never report ready. Neither RPC URL, path,
 * query token or credential is ever logged: hosts are redacted before any
 * stderr line is written.
 *
 * Usage:
 *   npm run readiness -- --mode pre-deploy
 *   npm run readiness -- --mode post-deploy --offline
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  EXPECTED_CHAIN_ID,
  EXPECTED_TOKEN_DECIMALS,
  redactRpcUrl,
  redactUrlsInText,
  runReadiness,
  serializeReadinessReport,
  type ReadinessArtifact,
  type ReadinessEnv,
  type ReadinessRpcProbe,
  type ReadinessRpcProbes,
} from '../packages/monad/src/deployment-readiness';

const FOUNDRY_OUT_DIR = 'packages/contracts/out';

interface Args {
  mode: 'pre-deploy' | 'post-deploy';
  offline: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mode: 'pre-deploy', offline: false, outDir: FOUNDRY_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') {
      const value = argv[index + 1];
      if (value !== 'pre-deploy' && value !== 'post-deploy') {
        throw new Error(`USAGE: --mode must be 'pre-deploy' or 'post-deploy', got '${value ?? ''}'`);
      }
      args.mode = value;
      index += 1;
    } else if (arg === '--offline') {
      args.offline = true;
    } else if (arg === '--out-dir') {
      args.outDir = argv[index + 1] ?? FOUNDRY_OUT_DIR;
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        [
          'Usage: npm run readiness -- [--mode pre-deploy|post-deploy] [--offline] [--out-dir <dir>]',
          '',
          'Never broadcasts. Two separate clients are built from',
          'XYX_PRIMARY_RPC_URL / XYX_RPC_URL and XYX_SECONDARY_RPC_URL; every chain',
          'check reads BOTH endpoints and requires them to agree. An --offline run,',
          'or a run missing either endpoint, is always NOT_READY.',
          '',
        ].join('\n'),
      );
      process.exit(0);
    } else {
      throw new Error(`USAGE: unknown argument '${arg}'`);
    }
  }
  return args;
}

function env(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * Load the three canonical contract artifacts. Returns undefined when the
 * output directory is absent so the caller can report ARTIFACT_MISSING.
 */
function loadArtifacts(outDir: string): ReadinessArtifact[] | undefined {
  if (!existsSync(outDir)) return undefined;
  const artifacts: ReadinessArtifact[] = [];
  for (const contractName of ['MonadP256Verifier', 'XYXPasskeyRegistry', 'XYXDeliveryProtocol']) {
    const path = join(outDir, `${contractName}.sol`, `${contractName}.json`);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        contractName?: string;
        bytecode?: { object?: string };
      };
      artifacts.push({
        path,
        contractName: parsed.contractName ?? contractName,
        bytecode: parsed.bytecode?.object ?? '',
      });
    } catch {
      artifacts.push({ path, contractName, bytecode: '' });
    }
  }
  return artifacts.length > 0 ? artifacts : undefined;
}

/**
 * Build a read-only viem probe bound to ONE endpoint. Only ever issues
 * `eth_chainId`, `eth_getCode` and `eth_call`. Imported lazily so `--offline`
 * never loads a transport, and called once per endpoint so the two probes are
 * genuinely distinct objects over genuinely distinct connections.
 */
async function createRpcProbe(rpcUrl: string): Promise<ReadinessRpcProbe> {
  const { createPublicClient, http } = await import('viem');
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    async chainId(): Promise<number> {
      const id = await client.getChainId();
      return Number(id);
    },
    async getCode(address) {
      const code = await client.getCode({ address });
      return (code ?? '0x') as `0x${string}`;
    },
    async call(to, data) {
      const result = await client.call({ to, data });
      return (result?.data ?? '0x') as `0x${string}`;
    },
  };
}

/**
 * A probe that reports why its endpoint is unusable on every call.
 *
 * Used when a client cannot be built at all: the run then fails closed with the
 * stable `RPC_PROBE_FAILED` code instead of crashing or silently falling back to
 * the other endpoint. The message is URL-redacted because transport errors echo
 * the endpoint they were given, including any query token.
 */
function unavailableRpcProbe(reason: string): ReadinessRpcProbe {
  const message = `RPC probe unavailable: ${redactUrlsInText(reason)}`;
  const refuse = (): never => {
    throw new Error(message);
  };
  return { chainId: refuse, getCode: refuse, call: refuse };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const primaryRpcUrl = env('XYX_PRIMARY_RPC_URL', 'XYX_RPC_URL', 'MONAD_RPC_URL_PRIMARY');
  const secondaryRpcUrl = env('XYX_SECONDARY_RPC_URL', 'MONAD_RPC_URL_SECONDARY');

  const readinessEnv: ReadinessEnv = {
    primaryRpcUrl,
    secondaryRpcUrl,
    paymentTokenAddress: env('MONAD_USDC_ADDRESS', 'XYX_PAYMENT_TOKEN_ADDRESS'),
    p256VerifierAddress: env('XYX_P256_VERIFIER_ADDRESS'),
    registryAddress: env('XYX_REGISTRY_ADDRESS'),
    protocolAddress: env('XYX_PROTOCOL_ADDRESS'),
    rpId: env('XYX_RP_ID'),
    rpIdHash: env('XYX_RP_ID_HASH'),
    maxVerdictLifetime: env('VERDICT_LIFETIME', 'XYX_MAX_VERDICT_LIFETIME'),
    deployerAddress: env('XYX_DEPLOYER_ADDRESS'),
    attestorAddress: env('XYX_ATTESTOR_ADDRESS'),
    relayerAddress: env('XYX_RELAYER_ADDRESS'),
    expectedTokenDecimals: EXPECTED_TOKEN_DECIMALS,
    gasBufferBps: env('XYX_GAS_BUFFER_BPS') || '0',
    gasEstimate: env('XYX_GAS_ESTIMATE'),
  };

  // Two clients, two endpoints, no shared connection. Each side of the pair is
  // bound to the URL it was built from, so "both RPCs agree" can only ever mean
  // two separately reachable nodes returned the same thing.
  const endpoints: Array<{ label: 'primary' | 'secondary'; url: string }> = [
    { label: 'primary', url: primaryRpcUrl },
    { label: 'secondary', url: secondaryRpcUrl },
  ];

  let probes: ReadinessRpcProbes;
  if (args.offline) {
    // No client is built at all. The harness reports
    // LIVE_DUAL_RPC_PROBE_REQUIRED, so an offline run is always NOT_READY.
    const reason = 'offline run requested; no RPC client was built';
    probes = {
      primary: unavailableRpcProbe(reason),
      secondary: unavailableRpcProbe(reason),
    };
  } else {
    probes = {
      primary: unavailableRpcProbe('not yet built'),
      secondary: unavailableRpcProbe('not yet built'),
    };
    for (const endpoint of endpoints) {
      if (endpoint.url === '') {
        probes[endpoint.label] = unavailableRpcProbe('RPC URL is empty');
        continue;
      }
      try {
        probes[endpoint.label] = await createRpcProbe(endpoint.url);
      } catch (error) {
        const detail = redactUrlsInText(error instanceof Error ? error.message : String(error));
        process.stderr.write(
          `${endpoint.label} RPC client could not be built (${redactRpcUrl(endpoint.url)}): ${detail}\n`,
        );
        probes[endpoint.label] = unavailableRpcProbe(detail);
      }
    }
  }

  const report = await runReadiness(readinessEnv, {
    mode: args.mode,
    probes,
    offline: args.offline,
    artifacts: loadArtifacts(args.outDir),
    rawEnvKeys: Object.keys(process.env),
  });

  process.stdout.write(`${serializeReadinessReport(report)}\n`);

  const observedLine =
    `Expected chain ID ${EXPECTED_CHAIN_ID}; ` +
    `observed from the live primary and secondary endpoints: ` +
    `${report.observedChainIds.primary ?? 'not queried'} / ` +
    `${report.observedChainIds.secondary ?? 'not queried'}\n`;

  if (report.ready) {
    process.stdout.write(
      `\nSTATUS: ${report.status}\n` +
        observedLine +
        `This is NOT an authorization to broadcast.\n` +
        `A human must still run the deploy script explicitly with --broadcast.\n`,
    );
    process.exit(0);
  }

  process.stdout.write(
    `\nSTATUS: ${report.status}\nFAILURES: ${report.failures.join(', ')}\n${observedLine}`,
  );
  process.exit(1);
}

main().catch((error: unknown) => {
  process.stderr.write(`READINESS_ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
