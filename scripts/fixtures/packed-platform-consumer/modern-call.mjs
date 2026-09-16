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

function assertDuration(durationMs) {
  assert.equal(typeof durationMs, 'number');
  assert.ok(Number.isFinite(durationMs) && durationMs >= 0);
}

// CJS calls this same scenario with its require()-loaded constructor. The SDK
// transport stays fetch-in-process: no listener, credentials or backend.
export async function runConsumer(createHandler = createSupabaseMcpHandler) {
  const scopes = [];
  let sinkFailure;
  let creates = 0;
  const observer = (context) => {
    if (sinkFailure === 'factory') throw new Error('PRIVATE_FACTORY_ERROR');
    const scope = { context, facts: [], ends: [] };
    scopes.push(scope);
    return {
      record(fact) {
        scope.facts.push(fact);
        if (sinkFailure === 'sink') throw new Error('PRIVATE_RECORD_ERROR');
      },
      end(end) {
        scope.ends.push(end);
        if (sinkFailure === 'sink') throw new Error('PRIVATE_END_ERROR');
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
    costConfirmation: {
      requestStateKey: 'a'.repeat(32), // fixed test-only key, never a credential
      principal: 'PRIVATE_PRINCIPAL',
      enabledTools: ['create_project'],
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
  const resume = (first, action) =>
    call({
      name: 'create_project',
      arguments: args,
      requestState: first.requestState,
      inputResponses: {
        confirm_cost:
          action === 'accept' ? { action, content: {} } : { action },
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
    const accepted = await resume(first, 'accept');
    assert.equal(accepted.isError, undefined);
    assert.deepEqual(accepted.content, [
      { type: 'text', text: JSON.stringify(project) },
    ]);
    assert.equal(creates, 1);
    const acceptedScope = scopes[2];
    assert.deepEqual(acceptedScope.facts.slice(0, 4), [
      decision,
      { kind: 'input_response', feature: 'cost', action: 'accept' },
      { kind: 'resume_validation', feature: 'cost', result: 'valid' },
      { kind: 'operation', feature: 'cost', disposition: 'started' },
    ]);
    const operation = acceptedScope.facts[4];
    assertDuration(operation.durationMs);
    assert.deepEqual(operation, {
      kind: 'operation',
      feature: 'cost',
      disposition: 'returned',
      durationMs: operation.durationMs,
    });
    assert.equal(acceptedScope.facts.length, 5);
    assert.equal(acceptedScope.ends[0].result, 'completed');
    assert.ok(acceptedScope.ends[0].durationMs >= operation.durationMs);

    const declined = await resume(await start(), 'decline');
    assert.deepEqual(declined.structuredContent, { status: 'declined' });
    assert.equal(creates, 1);
    assert.deepEqual(scopes[4].facts, [
      decision,
      { kind: 'input_response', feature: 'cost', action: 'decline' },
    ]);
    assert.equal(scopes[4].ends[0].result, 'declined');

    // Sink and factory failures cannot suppress issuance or the paid operation.
    for (const failure of ['sink', 'factory']) {
      sinkFailure = failure;
      const result = await resume(await start(), 'accept');
      assert.deepEqual(result, accepted);
    }
    sinkFailure = undefined;
    assert.equal(creates, 3);
    for (const scope of scopes) {
      assert.deepEqual(
        scope.context,
        scope === scopes[0]
          ? { method: 'tools/list', tool: 'not_applicable' }
          : { method: 'tools/call', tool: 'create_project' }
      );
      assert.equal(scope.ends.length, 1);
      const end = scope.ends[0];
      assertDuration(end.durationMs);
      assert.deepEqual(Object.keys(end).sort(), ['durationMs', 'result']);
    }
    const serialized = JSON.stringify(scopes);
    assert.ok(
      !serialized.includes('PRIVATE_'),
      'payload or sink error leaked into observations'
    );
    assert.ok(
      !serialized.includes(first.requestState),
      'signed state leaked into observations'
    );
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
