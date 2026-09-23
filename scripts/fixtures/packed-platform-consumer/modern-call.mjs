import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createSupabaseMcpHandler } from '@supabase/mcp-server-supabase';

// https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
const MODERN_PROTOCOL_VERSION = '2026-07-28';

const project = {
  id: 'PRIVATE_PROJECT_ID',
  ref: 'PRIVATE_PROJECT_REF',
  organization_id: 'PRIVATE_ORGANIZATION',
  organization_slug: 'PRIVATE_SLUG',
  name: 'PRIVATE_PROJECT_NAME',
  status: 'ACTIVE_HEALTHY',
  created_at: '2026-01-01T00:00:00Z',
  region: 'us-east-1',
};
const args = {
  name: project.name,
  region: project.region,
  organization_id: project.organization_id,
};
const decision = {
  kind: 'confirmation_decision',
  feature: 'cost',
  route: 'inline',
  reason: 'eligible',
};
const issuance = {
  kind: 'input_required',
  feature: 'cost',
  mode: 'form',
  reason: 'initial',
};

// CJS calls this same scenario with its require()-loaded constructor. The SDK
// transport stays fetch-in-process: no listener, credentials or backend.
export async function runConsumer(createHandler = createSupabaseMcpHandler) {
  const scopes = [];
  let creates = 0;
  const observer = (context) => {
    const scope = { context, facts: [], ends: [] };
    scopes.push(scope);
    return {
      record(fact) {
        scope.facts.push(fact);
      },
      end(end) {
        scope.ends.push(end);
      },
    };
  };
  const notImplemented = () =>
    Promise.reject(new Error('unexpected platform call'));
  const handler = createHandler({
    observer,
    platform: {
      account: {
        listOrganizations: notImplemented,
        getOrganization: async () => ({
          id: project.organization_id,
          name: 'PRIVATE_ORG_NAME',
          plan: 'pro',
          allowed_release_channels: [],
          opt_in_tags: [],
        }),
        listProjects: async () => [project],
        getProject: notImplemented,
        createProject: async (input) => {
          assert.deepEqual(input, args);
          creates++;
          return project;
        },
        pauseProject: notImplemented,
        restoreProject: notImplemented,
      },
    },
    // docs descriptions can fetch supabase.com; deliberately register account only.
    features: ['account'],
    elicitation: {
      requestState: {
        key: 'a'.repeat(32), // fixed test-only key, never a credential
        principal: 'PRIVATE_PRINCIPAL',
      },
      confirmation: { enabledTools: ['create_project'] },
    },
  });
  const transport = new StreamableHTTPClientTransport(
    new URL('http://packed-platform-consumer-fixture.invalid/mcp'),
    { fetch: (url, init) => handler.fetch(new Request(url, init)) }
  );
  const client = new Client(
    { name: 'PRIVATE_CLIENT_NAME', version: '0.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: MODERN_PROTOCOL_VERSION } },
      inputRequired: { autoFulfill: false },
    }
  );
  const call = (params) =>
    client.request(
      { method: 'tools/call', params },
      { allowInputRequired: true }
    );
  const start = () => call({ name: 'create_project', arguments: args });
  const resume = (first) =>
    call({
      name: 'create_project',
      arguments: args,
      requestState: first.requestState,
      inputResponses: {
        confirm_cost: { action: 'accept', content: {} },
      },
    });
  try {
    await client.connect(transport);
    assert.equal(
      scopes.length,
      0,
      'initialize must not start a producer scope'
    );
    const { tools } = await client.listTools();
    const listProjects = tools.find((tool) => tool.name === 'list_projects');
    assert.ok(listProjects?.inputSchema);
    const createProject = tools.find((tool) => tool.name === 'create_project');
    assert.ok(createProject?.inputSchema?.properties);
    for (const property of ['name', 'region', 'organization_id']) {
      assert.ok(
        Object.hasOwn(createProject.inputSchema.properties, property),
        `missing schema property ${property}`
      );
    }
    assert.deepEqual(scopes[0].context, {
      method: 'tools/list',
      tool: 'not_applicable',
    });
    assert.deepEqual(scopes[0].facts, []);
    assert.equal(scopes[0].ends[0].result, 'completed');

    const first = await start();
    assert.ok(first.inputRequests?.confirm_cost);
    assert.equal(typeof first.requestState, 'string');
    assert.equal(creates, 0);
    assert.deepEqual(scopes[1].facts, [decision, issuance]);
    assert.equal(scopes[1].ends[0].result, 'input_required');
    const accepted = await resume(first);
    assert.equal(accepted.isError, undefined);
    assert.deepEqual(accepted.content, [
      { type: 'text', text: JSON.stringify(project) },
    ]);
    assert.equal(creates, 1);
    return tools.length;
  } finally {
    await client.close();
    await handler.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  console.log(`MODERN_CALL_OK tools=${await runConsumer()}`);
}
