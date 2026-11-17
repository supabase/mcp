#!/usr/bin/env node
// Runs everything needed to visually test MCP Apps views against the mock
// Management API: the mock API, the dev server (via dev-http.mjs) and MCP
// Inspector. Extra args are forwarded to dev:http. Set MOCK_API_PORT to change
// the mock's port and MOCK_TOKEN to change the bearer token (default `mock`).
import { spawn } from 'node:child_process';
import { connect } from 'node:net';

const port = process.env.MOCK_API_PORT ?? '4010';
const token = process.env.MOCK_TOKEN ?? 'mock';
const apiUrl = `http://localhost:${port}`;
const children = [];
let shuttingDown = false;

// Each child gets its own process group so that stopping it also stops the
// grandchildren (pnpm -> node -> watchers). That also means the terminal's
// Ctrl-C no longer reaches them, so we forward it from the signal handlers.
function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    detached: true,
    env: { ...process.env, FORCE_COLOR: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const [stream, out] of [
    [child.stdout, process.stdout],
    [child.stderr, process.stderr],
  ]) {
    let buffered = '';
    stream.on('data', (chunk) => {
      const lines = (buffered + chunk).split('\n');
      buffered = lines.pop();
      for (const line of lines) out.write(`[${name}] ${line}\n`);
    });
    stream.on('end', () => {
      if (buffered) out.write(`[${name}] ${buffered}\n`);
    });
  }
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`[dev-mock] ${name} exited (${signal ?? code}), stopping`);
    }
    shutdown(code ?? 1);
  });
  children.push(child);
  return child;
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // group already gone
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) killGroup(child, 'SIGTERM');
  // Escalate for anything that ignores SIGTERM, then exit.
  setTimeout(() => {
    for (const child of children) killGroup(child, 'SIGKILL');
    process.exit(code);
  }, 3000).unref();
  // Exit early once every group is gone.
  const poll = setInterval(() => {
    const alive = children.some((child) => {
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) process.exit(code);
  }, 100);
  poll.unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));

function canConnect() {
  return new Promise((resolve) => {
    const socket = connect({ port: Number(port), host: 'localhost' });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

run('mock-api', 'pnpm', ['mock-api'], { MOCK_API_PORT: port });

// The dev server's first requests would fail if the mock weren't listening.
while (!shuttingDown && !(await canConnect())) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (shuttingDown) await new Promise(() => {});

run('dev-http', 'pnpm', [
  'dev:http',
  '--api-url',
  apiUrl,
  '--secret-url-template',
  `${apiUrl}/mcp/secrets?ref={ref}&name={name}`,
  ...process.argv.slice(2),
]);
run('inspector', 'pnpm', ['inspector'], { SUPABASE_ACCESS_TOKEN: token });
