/**
 * Run one real-only TypeSafe Jev triage over a sanitized engineering report.
 *
 * Usage:
 *   npm run workflow:triage -- --input /absolute/or/relative/report.json
 *
 * The package command loads .env.workflow.local only when that ignored file
 * exists. This command never loads the deployment .env, writes no output file,
 * changes no chain state, and exits non-zero when Jev is unavailable.
 */

import { readFileSync } from 'node:fs';
import { runJevWorkflowTriage } from '../packages/monad/src/workflow-triage';

interface Args {
  input?: string;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') {
      const value = argv[index + 1];
      if (!value) throw new Error('WORKFLOW_TRIAGE_USAGE');
      args.input = value;
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      args.help = true;
    } else {
      throw new Error('WORKFLOW_TRIAGE_USAGE');
    }
  }
  return args;
}

function usage(): string {
  return [
    'Usage: npm run workflow:triage -- --input <sanitized-work-report.json>',
    '',
    'Reads .env.workflow.local if it exists. A real TYPESAFE_API_KEY is required.',
    'No mock, fixture, fallback model, deployment, transaction, signing, or write occurs.',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.input) throw new Error('WORKFLOW_TRIAGE_USAGE');

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(args.input, 'utf8'));
  } catch {
    throw new Error('WORKFLOW_TRIAGE_INPUT_INVALID');
  }

  const result = await runJevWorkflowTriage(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== 'AVAILABLE') process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^WORKFLOW_TRIAGE_(USAGE|INPUT_INVALID)$/.test(error.message)
    ? error.message
    : 'WORKFLOW_TRIAGE_FAILED';
  process.stderr.write(`${code}\n`);
  process.exit(2);
});
