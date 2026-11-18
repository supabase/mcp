#!/usr/bin/env node

// Runs everything needed to visually test MCP Apps views against the mock
// Management API: the mock API, the dev server (via dev-http.mjs) and MCP
// Inspector. Extra args are forwarded to dev:http. Set MOCK_API_PORT to change
// the mock's port and MOCK_TOKEN to change the bearer token (default `mock`).
// MCP_QUERY (e.g. `features=database` or `project_ref=…`) is appended to the
// MCP URL that Inspector connects to; see the `inspector` script.

import { concurrently } from 'concurrently';

const port = process.env.MOCK_API_PORT ?? '4010';
const token = process.env.MOCK_TOKEN ?? 'mock';
const apiUrl = `http://localhost:${port}`;
const extraArgs = process.argv
  .slice(2)
  .map((arg) => JSON.stringify(arg))
  .join(' ');

const { result } = concurrently(
  [
    {
      name: 'mock-api',
      command: 'pnpm mock-api',
      env: { MOCK_API_PORT: port },
    },
    {
      name: 'dev-http',
      command: `pnpm exec wait-on tcp:localhost:${port} && pnpm dev:http --api-url ${apiUrl} --secret-url-template "${apiUrl}/mcp/secrets?ref={ref}&name={name}" ${extraArgs}`,
    },
    {
      name: 'inspector',
      command: 'pnpm inspector',
      env: { SUPABASE_ACCESS_TOKEN: token },
    },
  ],
  { killOthersOn: ['failure', 'success'], prefixColors: 'auto' }
);

result.catch(() => process.exit(1));
