#!/usr/bin/env node
/** Run one real-only Jev supervision checkpoint over a sanitized report. */

import { readFileSync } from 'node:fs';
import { runJevBuildSupervisor } from '../packages/monad/src/workflow-supervisor';

function usage(): string {
  return [
    'Usage: npm run workflow:supervise -- --input <sanitized-checkpoint.json>',
    '',
    'The command validates ownership and gates before any TypeSafe request.',
    'Its correction packet is advisory and cannot merge, deploy, broadcast, sign, or release.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): { help: boolean; input?: string } {
  let input: string | undefined;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--input') input = argv[++index];
    else throw new Error('WORKFLOW_SUPERVISOR_USAGE');
  }
  return { help, input };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!args.input) throw new Error('WORKFLOW_SUPERVISOR_USAGE');

  let input: unknown;
  try {
    input = JSON.parse(readFileSync(args.input, 'utf8'));
  } catch {
    throw new Error('WORKFLOW_SUPERVISOR_INPUT_INVALID');
  }

  const result = await runJevBuildSupervisor(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  const mayAdvance = result.status === 'AVAILABLE' && (
    result.nextAction === 'START_REVIEWER_07' || result.nextAction === 'HUMAN_RELEASE_REVIEW'
  );
  if (!mayAdvance) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  const code = error instanceof Error && /^WORKFLOW_SUPERVISOR_(USAGE|INPUT_INVALID)$/.test(error.message)
    ? error.message
    : 'WORKFLOW_SUPERVISOR_FAILED';
  process.stderr.write(`${code}\n`);
  process.exit(2);
});
