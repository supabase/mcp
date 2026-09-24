import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const endpoint = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:3111/mcp');
assert(
  endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(endpoint.hostname),
  'MCP_URL must point to a loopback HTTP server',
);
endpoint.searchParams.set('read_only', 'true');

const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { Authorization: ['Bearer', 'local-smoke-only'].join(' ') } },
});
const client = new Client(
  { name: 'mcp-product-analytics-smoke', version: '1.0.0' },
  { capabilities: {} },
);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  assert(names.has('list_projects'), 'Local HTTP MCP must expose list_projects');
  assert(names.has('search_docs'), 'Local HTTP MCP must expose search_docs');
  assert(tools.every((tool) => tool.annotations?.readOnlyHint !== false), 'Smoke endpoint must be read-only');
  console.log(
    JSON.stringify({
      endpoint: `${endpoint.origin}${endpoint.pathname}?read_only=true`,
      requiredTools: ['list_projects', 'search_docs'],
      status: 'pass',
      toolCount: tools.length,
    }),
  );
} finally {
  await client.close();
}
