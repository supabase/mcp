#!/usr/bin/env node
// Watches the packages and restarts the --http server when the server's dist
// changes. MCP Apps views (packages/mcp-ui) rebuild on change, and the server
// also watches their built HTML, since it's inlined into the server bundle.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const cli = 'packages/mcp-server-supabase/dist/cli.js';
const children = [];

function run(cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
  child.on('exit', (code) => shutdown(code ?? 0));
  children.push(child);
}

function shutdown(code) {
  for (const child of children) child.kill();
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (!existsSync(cli)) spawnSync('pnpm', ['build'], { stdio: 'inherit' });

run('pnpm', ['build:watch'], 'packages/mcp-ui');
run('node_modules/.bin/tsup', ['--watch'], 'packages/mcp-utils');
run(
  'node_modules/.bin/tsup',
  ['--watch', '.', '--watch', '../mcp-ui/dist'],
  'packages/mcp-server-supabase'
);
run('node', ['--watch', cli, '--http', ...process.argv.slice(2)]);
