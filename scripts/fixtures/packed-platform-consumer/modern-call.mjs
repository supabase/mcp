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
  let sqlExecutions = 0;
  const sqlArgs = {
    project_id: project.id,
    query: 'DROP TABLE "PRIVATE_TABLE"; -- PRIVATE_SQL',
  };
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
      database: {
        executeSql: async (projectId, input) => {
          assert.equal(projectId, project.id);
          assert.deepEqual(input, {
            query: sqlArgs.query,
            read_only: undefined,
          });
          sqlExecutions++;
          return [{ private_result: 'PRIVATE_RESULT' }];
        },
        applyMigration: notImplemented,
        listMigrations: notImplemented,
      },
    },
    // Exclude docs descriptions, which can fetch supabase.com.
    features: ['account', 'database'],
    elicitation: {
      requestState: {
        key: 'a'.repeat(32), // fixed test-only key, never a credential
        principal: 'PRIVATE_PRINCIPAL',
      },
      confirmation: { enabledTools: ['create_project', 'execute_sql'] },
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

    const sqlFirst = await call({ name: 'execute_sql', arguments: sqlArgs });
    assert.ok(sqlFirst.inputRequests?.confirm_destructive);
    assert.equal(typeof sqlFirst.requestState, 'string');
    assert.equal(sqlExecutions, 0);
    assert.deepEqual(scopes[3].facts, [
      { ...decision, feature: 'destructive_sql' },
      { ...issuance, feature: 'destructive_sql' },
    ]);
    assert.equal(scopes[3].ends[0].result, 'input_required');
    const sqlAccepted = await call({
      name: 'execute_sql',
      arguments: sqlArgs,
      requestState: sqlFirst.requestState,
      inputResponses: {
        confirm_destructive: { action: 'accept', content: {} },
      },
    });
    assert.notEqual(sqlAccepted.isError, true);
    assert.equal(sqlExecutions, 1);
    assert.match(JSON.stringify(sqlAccepted), /PRIVATE_RESULT/);
    const sqlResume = scopes[4];
    assert.deepEqual(sqlResume.context, {
      method: 'tools/call',
      tool: 'execute_sql',
    });
    assert.deepEqual(sqlResume.facts.slice(0, 4), [
      { ...decision, feature: 'destructive_sql' },
      { kind: 'input_response', feature: 'destructive_sql', action: 'accept' },
      {
        kind: 'resume_validation',
        feature: 'destructive_sql',
        result: 'valid',
      },
      { kind: 'operation', feature: 'destructive_sql', disposition: 'started' },
    ]);
    assert.equal(sqlResume.facts.length, 5);
    const returned = sqlResume.facts[4];
    assert.deepEqual(returned, {
      kind: 'operation',
      feature: 'destructive_sql',
      disposition: 'returned',
      durationMs: returned.durationMs,
    });
    assert.equal(sqlResume.ends.length, 1);
    assert.equal(sqlResume.ends[0].result, 'completed');
    for (const scope of scopes) {
      for (const event of [...scope.facts, ...scope.ends]) {
        if ('durationMs' in event) {
          assert.ok(Number.isFinite(event.durationMs));
          assert.ok(event.durationMs >= 0);
        }
      }
    }
    assert.doesNotMatch(JSON.stringify(scopes), /PRIVATE_/);
    assert.ok(!JSON.stringify(scopes).includes(sqlFirst.requestState));
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
