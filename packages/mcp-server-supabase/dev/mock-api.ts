/**
 * A long-running fake Supabase Management API for visually testing MCP Apps
 * views (create-project, create-branch) without a real account or PAT.
 *
 *   pnpm mock-api                                  # listens on :4010
 *   curl -X POST localhost:4010/__scenario -d '{"name":"create-project:init-failed"}'
 *
 * Switch scenarios at runtime; no restart needed. See `scenarios` below and
 * `dev/README.md` for how to point the MCP server at it.
 *
 * Response shapes are typed from the generated Management API types so they
 * stay correct when the spec is regenerated.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { components } from '../src/management-api/types.js';

type Schemas = components['schemas'];
type Project = Schemas['V1ProjectWithDatabaseResponse_Output'];
type Branch = Schemas['BranchResponse_Output'];
type ProjectStatus = Project['status'];
type BranchStatus = Branch['status'];

const PORT = Number(process.env.MOCK_API_PORT ?? process.argv[2] ?? 4010);

// ---------------------------------------------------------------------------
// Scenarios

type PollErrors = [message: string, count: number][];

/** Total number of leading polls that fail. */
function pollErrorCount(errors: PollErrors = []): number {
  return errors.reduce((total, [, count]) => total + count, 0);
}

/** The error message for the given (0-based) poll, or undefined once the errors are used up. */
function pollError(errors: PollErrors = [], poll: number): string | undefined {
  for (const [message, count] of errors) {
    if (poll < count) return message;
    poll -= count;
  }
  return undefined;
}

type Scenario = {
  description: string;
  /** Status returned by each successive `GET /v1/projects/{ref}` poll of a project created while active; the last one repeats. */
  projectStatuses: ProjectStatus[];
  /** Creating a project fails with a 400 and this message. */
  projectCreateError?: string;
  /** Creating a branch fails with a 400 and this message. */
  branchCreateError?: string;
  /** Leading polls that fail with a 503: each `[message, count]` entry fails `count` polls in a row with `message`, in order. */
  projectPollErrors?: PollErrors;
  /** Same as `projectPollErrors`, per branch, for branch list polls. */
  branchPollErrors?: PollErrors;
  /** Status returned by each successive branch list for a branch created while active; the last one repeats. */
  branchStatuses: BranchStatus[];
};

const HAPPY_PROJECT: ProjectStatus[] = [
  'COMING_UP',
  'COMING_UP',
  'ACTIVE_HEALTHY',
];
const HAPPY_BRANCH: BranchStatus[] = [
  'CREATING_PROJECT',
  'RUNNING_MIGRATIONS',
  'MIGRATIONS_PASSED',
  'FUNCTIONS_DEPLOYED',
];

const scenarios: Record<string, Scenario> = {
  happy: {
    description:
      'Everything succeeds (default). Same as the two :happy scenarios.',
    projectStatuses: HAPPY_PROJECT,
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:happy': {
    description: 'COMING_UP, COMING_UP, ACTIVE_HEALTHY',
    projectStatuses: HAPPY_PROJECT,
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:init-failed': {
    description: 'COMING_UP, then INIT_FAILED',
    projectStatuses: ['COMING_UP', 'INIT_FAILED'],
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:polling-timeout': {
    description:
      'COMING_UP forever. The view gives up after POLL_TIMEOUT_MS (10 minutes).',
    projectStatuses: ['COMING_UP'],
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:polling-error': {
    description:
      'First poll fails with "Service temporarily unavailable" (503); retry then follows the happy sequence',
    projectStatuses: HAPPY_PROJECT,
    projectPollErrors: [['Service temporarily unavailable', 1]],
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:health-checks': {
    description:
      'COMING_UP, ACTIVE_UNHEALTHY, ACTIVE_UNHEALTHY, ACTIVE_HEALTHY: shows the health checks step',
    projectStatuses: [
      'COMING_UP',
      'ACTIVE_UNHEALTHY',
      'ACTIVE_UNHEALTHY',
      'ACTIVE_HEALTHY',
    ],
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:polling-down': {
    description:
      'The first 3 polls fail with a 503, so the view stops polling; Retry then follows the happy sequence',
    projectStatuses: HAPPY_PROJECT,
    projectPollErrors: [['Service temporarily unavailable', 3]],
    branchStatuses: HAPPY_BRANCH,
  },
  'create-project:create-failed': {
    description: 'POST /v1/projects fails, so the tool call returns an error',
    projectStatuses: HAPPY_PROJECT,
    projectCreateError: 'Project limit reached for this organization',
    branchStatuses: HAPPY_BRANCH,
  },
  'create-branch:happy': {
    description:
      'CREATING_PROJECT, RUNNING_MIGRATIONS, MIGRATIONS_PASSED, FUNCTIONS_DEPLOYED',
    projectStatuses: HAPPY_PROJECT,
    branchStatuses: HAPPY_BRANCH,
  },
  'create-branch:migrations-failed': {
    description: 'CREATING_PROJECT, RUNNING_MIGRATIONS, MIGRATIONS_FAILED',
    projectStatuses: HAPPY_PROJECT,
    branchStatuses: [
      'CREATING_PROJECT',
      'RUNNING_MIGRATIONS',
      'MIGRATIONS_FAILED',
    ],
  },
  'create-branch:functions-failed': {
    description: 'RUNNING_MIGRATIONS, MIGRATIONS_PASSED, FUNCTIONS_FAILED',
    projectStatuses: HAPPY_PROJECT,
    branchStatuses: [
      'RUNNING_MIGRATIONS',
      'MIGRATIONS_PASSED',
      'FUNCTIONS_FAILED',
    ],
  },
  'create-branch:create-failed': {
    description:
      'POST /v1/projects/{ref}/branches fails, so the tool call returns an error',
    projectStatuses: HAPPY_PROJECT,
    branchCreateError: 'Branching is not enabled for this project',
    branchStatuses: HAPPY_BRANCH,
  },
  'create-branch:polling-error': {
    description:
      'First poll fails with "Service temporarily unavailable" (503); retry then follows the happy sequence',
    projectStatuses: HAPPY_PROJECT,
    branchPollErrors: [['Service temporarily unavailable', 1]],
    branchStatuses: HAPPY_BRANCH,
  },
  'create-branch:polling-timeout': {
    description:
      'RUNNING_MIGRATIONS forever. The view gives up after POLL_TIMEOUT_MS (10 minutes).',
    projectStatuses: HAPPY_PROJECT,
    branchStatuses: ['RUNNING_MIGRATIONS'],
  },
};

const DEFAULT_SCENARIO = 'happy';
let scenarioName = DEFAULT_SCENARIO;

// ---------------------------------------------------------------------------
// State

const ORG_PRO = 'acme';
const ORG_FREE = 'hobby';
const SEED_REF = 'abcdefghijklmnopqrst';

type ProjectState = { project: Project; polls: number; seeded: boolean };
type BranchState = { branch: Branch; polls: number; seeded: boolean };

const projects = new Map<string, ProjectState>();
/** Keyed by parent project ref. */
const branches = new Map<string, BranchState[]>();

function randomRef(): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return Array.from(
    { length: 20 },
    () => letters[Math.floor(Math.random() * letters.length)]
  ).join('');
}

function makeProject(init: Partial<Project> & { ref: string }): Project {
  return {
    id: init.ref,
    organization_id: ORG_PRO,
    organization_slug: ORG_PRO,
    name: 'Project',
    region: 'us-east-1',
    created_at: new Date().toISOString(),
    status: 'COMING_UP',
    database: {
      host: `db.${init.ref}.supabase.red`,
      version: '17.6.1.054',
      postgres_engine: '17',
      release_channel: 'ga',
    },
    ...init,
  };
}

function resetState() {
  projects.clear();
  branches.clear();
  projects.set(SEED_REF, {
    seeded: true,
    polls: 0,
    project: makeProject({
      ref: SEED_REF,
      name: 'Acme production',
      status: 'ACTIVE_HEALTHY',
      created_at: '2026-01-01T00:00:00.000Z',
    }),
  });
  branches.set(SEED_REF, [
    {
      seeded: true,
      polls: 0,
      branch: makeBranch({
        parent: SEED_REF,
        name: 'other',
        status: 'FUNCTIONS_DEPLOYED',
      }),
    },
  ]);
}

function makeBranch(init: {
  parent: string;
  name: string;
  status: BranchStatus;
}): Branch {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: init.name,
    project_ref: randomRef(),
    parent_project_ref: init.parent,
    is_default: false,
    persistent: false,
    status: init.status,
    created_at: now,
    updated_at: now,
    with_data: false,
  };
}

/** Restarts every status sequence, e.g. when the scenario changes. */
function resetPolling() {
  for (const p of projects.values()) p.polls = 0;
  for (const list of branches.values()) for (const b of list) b.polls = 0;
}

const active = () => scenarios[scenarioName]!;
const pick = <T>(list: T[], n: number): T =>
  list[Math.min(n, list.length - 1)]!;

// ---------------------------------------------------------------------------
// HTTP plumbing

type Handler = (ctx: Ctx) => Reply | Promise<Reply>;
type Ctx = { params: Record<string, string>; body: any; url: URL };
type Reply = {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  html?: string;
};

const routes: {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}[] = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/\{(\w+)\}/g, (_, key) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '/?$'
  );
  routes.push({ method, pattern, keys, handler });
}

const notFound = (message: string): Reply => ({
  status: 404,
  body: { message },
});

// ---------------------------------------------------------------------------
// Control endpoints

route('GET', '/__scenario', () => ({
  body: {
    current: scenarioName,
    available: Object.fromEntries(
      Object.entries(scenarios).map(([name, s]) => [name, s.description])
    ),
  },
}));

route('POST', '/__scenario', ({ body }) => {
  const name = body?.name;
  if (typeof name !== 'string' || !(name in scenarios)) {
    return {
      status: 400,
      body: {
        message: `Unknown scenario: ${String(name)}`,
        available: Object.keys(scenarios),
      },
    };
  }
  scenarioName = name;
  resetPolling();
  return { body: { current: scenarioName } };
});

route('POST', '/__reset', () => {
  scenarioName = DEFAULT_SCENARIO;
  resetState();
  return { body: { current: scenarioName, reset: true } };
});

// ---------------------------------------------------------------------------
// Management API

const organizations: Schemas['OrganizationResponseV1_Output'][] = [
  { id: ORG_PRO, slug: ORG_PRO, name: 'Acme (Pro)' },
  { id: ORG_FREE, slug: ORG_FREE, name: 'Hobby (Free)' },
];

route('GET', '/v1/organizations', () => ({ body: organizations }));

// `acme` is on a paid plan with an active project, so a new project costs money
// and shows the cost confirmation. `hobby` is free, so it creates at $0.
route('GET', '/v1/organizations/{slug}', ({ params }) => {
  const org = organizations.find((o) => o.slug === params.slug);
  if (!org) return notFound(`Organization not found: ${params.slug}`);
  const response: Schemas['V1OrganizationSlugResponse_Output'] = {
    id: org.id,
    name: org.name,
    plan: org.slug === ORG_FREE ? 'free' : 'pro',
    opt_in_tags: [],
    allowed_release_channels: ['ga'],
  };
  return { body: response };
});

route('GET', '/v1/projects', () => ({
  body: [...projects.values()].map((p) => p.project),
}));

route('POST', '/v1/projects', ({ body }) => {
  const { projectCreateError } = active();
  if (projectCreateError) {
    return { status: 400, body: { message: projectCreateError } };
  }
  const ref = randomRef();
  const project = makeProject({
    ref,
    name: body?.name ?? 'Untitled',
    region: body?.region ?? 'us-east-1',
    organization_id: body?.organization_slug ?? ORG_PRO,
    organization_slug: body?.organization_slug ?? ORG_PRO,
    status: 'COMING_UP',
  });
  projects.set(ref, { project, polls: 0, seeded: false });
  const { database: _database, ...response } = project;
  return {
    status: 201,
    body: response satisfies Schemas['V1ProjectResponse_Output'],
  };
});

route('GET', '/v1/projects/{ref}', ({ params }) => {
  const state = projects.get(params.ref!);
  if (!state) return notFound(`Project not found: ${params.ref}`);
  if (state.seeded) return { body: state.project };

  const scenario = active();
  const poll = state.polls++;
  const message = pollError(scenario.projectPollErrors, poll);
  if (message) return { status: 503, body: { message } };
  const index = poll - pollErrorCount(scenario.projectPollErrors);
  state.project = {
    ...state.project,
    status: pick(scenario.projectStatuses, index),
  };
  return { body: state.project };
});

route('GET', '/v1/projects/{ref}/branches', ({ params }) => {
  const list = branches.get(params.ref!) ?? [];
  const scenario = active();
  const failures = pollErrorCount(scenario.branchPollErrors);
  const failing = list.filter(
    (state) => !state.seeded && state.polls < failures
  );
  if (failing.length > 0) {
    const message = pollError(scenario.branchPollErrors, failing[0]!.polls);
    for (const state of failing) state.polls++;
    return { status: 503, body: { message } };
  }
  const offset = failures;
  const response: Branch[] = list.map((state) => {
    if (!state.seeded) {
      state.branch = {
        ...state.branch,
        status: pick(scenario.branchStatuses, state.polls++ - offset),
        updated_at: new Date().toISOString(),
      };
    }
    return state.branch;
  });
  return { body: response };
});

route('POST', '/v1/projects/{ref}/branches', ({ params, body }) => {
  const { branchCreateError } = active();
  if (branchCreateError) {
    return { status: 400, body: { message: branchCreateError } };
  }
  const branch = makeBranch({
    parent: params.ref!,
    name: body?.branch_name ?? 'branch',
    status: 'CREATING_PROJECT',
  });
  const list = branches.get(params.ref!) ?? [];
  list.push({ branch, polls: 0, seeded: false });
  branches.set(params.ref!, list);
  // The branch is itself a project: execute_sql etc. work against its ref.
  projects.set(branch.project_ref, {
    seeded: true,
    polls: 0,
    project: makeProject({
      ref: branch.project_ref,
      name: branch.name,
      status: 'ACTIVE_HEALTHY',
    }),
  });
  return { status: 201, body: branch };
});

route('GET', '/v1/projects/{ref}/api-keys', ({ params }) => {
  if (!projects.has(params.ref!))
    return notFound(`Project not found: ${params.ref}`);
  const keys: Schemas['ApiKeyResponse_Output'][] = [
    {
      api_key: 'eyJhbGciOiJIUzI1NiJ9.legacy-anon-key.signature',
      id: 'anon',
      name: 'anon',
      type: 'legacy',
    },
    {
      api_key: 'sb_publishable_AbCdEfGhIjKlMnOpQrStUv_0123456',
      id: 'publishable-default',
      name: 'default',
      type: 'publishable',
    },
    {
      // Not client-safe: the tool filters this out.
      api_key: 'sb_secret_****',
      id: 'secret-default',
      name: 'default',
      type: 'secret',
    },
  ];
  return { body: keys };
});

route('GET', '/v1/projects/{ref}/api-keys/legacy', () => ({
  body: { enabled: true } satisfies Schemas['LegacyApiKeysResponse_Output'],
}));

route('POST', '/v1/projects/{ref}/database/query', ({ params }) => {
  if (!projects.has(params.ref!))
    return notFound(`Project not found: ${params.ref}`);
  return { status: 201, body: [{ '?column?': 1 }] };
});

route('GET', '/v1/projects/{ref}/secrets', () => ({ body: [] }));

route('GET', '/v1/profile', () => ({
  headers: { 'X-Gotrue-Id': '00000000-0000-4000-8000-000000000000' },
  body: {
    id: 'mock-user',
    username: 'mock',
    primary_email: 'mock@example.com',
  },
}));

// What `--secret-url-template` points at, so clicking it doesn't 404.
route('GET', '/mcp/secrets', ({ url }) => ({
  html: `<!doctype html><title>Mock secret collection</title><p>Mock dashboard: collect secret <code>${escapeHtml(
    url.searchParams.get('name') ?? ''
  )}</code> for project <code>${escapeHtml(url.searchParams.get('ref') ?? '')}</code>.</p>`,
}));

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------
// Server

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function send(res: ServerResponse, reply: Reply) {
  const status = reply.status ?? 200;
  if (reply.html !== undefined) {
    res.writeHead(status, { 'content-type': 'text/html', ...reply.headers });
    res.end(reply.html);
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    ...reply.headers,
  });
  res.end(JSON.stringify(reply.body ?? {}));
}

const server = createServer(async (req, res) => {
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`
  );
  const method = req.method ?? 'GET';
  const body = await readBody(req);
  let reply: Reply | undefined;

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(url.pathname);
    if (!match) continue;
    const params = Object.fromEntries(
      r.keys.map((key, i) => [key, decodeURIComponent(match[i + 1]!)])
    );
    try {
      reply = await r.handler({ params, body, url });
    } catch (error) {
      console.error(error);
      reply = { status: 500, body: { message: String(error) } };
    }
    break;
  }

  if (!reply) {
    console.error(
      `!! UNHANDLED ROUTE: ${method} ${url.pathname}${url.search}  body=${JSON.stringify(body)}`
    );
    reply = notFound(`mock-api: no handler for ${method} ${url.pathname}`);
  }

  send(res, reply);
  const internal = url.pathname.startsWith('/__');
  console.log(
    `[${new Date().toLocaleTimeString('en-GB')}] ${method} ${url.pathname}${url.search} -> ${reply.status ?? 200}` +
      (internal ? '' : `  [${scenarioName}]`)
  );
});

resetState();
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mock Supabase Management API on http://localhost:${PORT}`);
  console.log(`Scenario: ${scenarioName}`);
  console.log(
    `Switch:   curl -X POST localhost:${PORT}/__scenario -d '{"name":"create-project:init-failed"}'`
  );
  console.log(`List:     curl localhost:${PORT}/__scenario`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => process.exit(0));
}
