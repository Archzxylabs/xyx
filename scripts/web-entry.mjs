import { existsSync } from 'node:fs';

// The root env file belongs to this workspace, while Next's app root is apps/web.
// Loading it in-process avoids propagating Node's --env-file flag to Next workers.
if (existsSync('.env')) process.loadEnvFile('.env');

await import('../node_modules/next/dist/bin/next');
