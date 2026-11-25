# Mock Management API

A fake Supabase Management API for visual testing of MCP Apps views in MCP
Inspector, with scenarios switchable at runtime.

From the repo root, `pnpm dev:mock` starts the mock API, the dev server pointed
at it and MCP Inspector in one go (Ctrl-C stops all three). To run the pieces
yourself:

```sh
pnpm build                  # once, so dist/cli.js exists
pnpm mock-api               # terminal 1: http://localhost:4010 (MOCK_API_PORT to change)

# terminal 2: the real server pointed at the mock (any token works)
node packages/mcp-server-supabase/dist/cli.js --http --port 3111 \
  --api-url http://localhost:4010 \
  --secret-url-template 'http://localhost:4010/mcp/secrets?ref={ref}&name={name}'
# or: pnpm dev:http --api-url ... --secret-url-template ...   (extra args are forwarded)

# terminal 3: connect MCP Inspector to
#   http://127.0.0.1:3111/mcp?experimental_apps=true   (Authorization: Bearer anything)

curl localhost:4010/__scenario                                            # current + available
curl -X POST localhost:4010/__scenario -d '{"name":"create-project:init-failed"}'
curl -X POST localhost:4010/__reset                                       # default scenario, drop created projects/branches
```

Switching scenarios restarts all status sequences. Each new project or branch
also starts its own sequence, advancing one step per poll.

## Scenarios

| Name | Behavior |
| --- | --- |
| `happy` (default) | all happy paths |
| `create-project:happy` | COMING_UP, COMING_UP, ACTIVE_HEALTHY |
| `create-project:init-failed` | COMING_UP, INIT_FAILED |
| `create-project:create-failed` | creating the project fails (400), so the tool call returns an error |
| `create-project:polling-timeout` | COMING_UP forever; the view times out after 10 minutes (`POLL_TIMEOUT_MS`) |
| `create-project:polling-error` | first poll is a 503 "Service temporarily unavailable"; retry then follows the happy sequence |
| `create-project:health-checks` | COMING_UP, ACTIVE_UNHEALTHY, ACTIVE_UNHEALTHY, ACTIVE_HEALTHY (shows the health checks step) |
| `create-project:polling-down` | the first 3 polls are 503s, so the view stops polling; Retry then follows the happy sequence |
| `create-branch:happy` | CREATING_PROJECT, RUNNING_MIGRATIONS, MIGRATIONS_PASSED, FUNCTIONS_DEPLOYED |
| `create-branch:migrations-failed` | CREATING_PROJECT, RUNNING_MIGRATIONS, MIGRATIONS_FAILED |
| `create-branch:functions-failed` | RUNNING_MIGRATIONS, MIGRATIONS_PASSED, FUNCTIONS_FAILED |
| `create-branch:create-failed` | creating the branch fails (400), so the tool call returns an error |
| `create-branch:polling-error` | first poll is a 503 "Service temporarily unavailable"; retry then follows the happy sequence |
| `create-branch:polling-timeout` | RUNNING_MIGRATIONS forever (10 minute timeout) |

## Server-flag scenarios

These are server configuration, not API behavior. In HTTP mode they are query
parameters on the MCP URL (CLI flags like `--features` don't apply). Set
`MCP_QUERY` to append them to the URL that `pnpm inspector` (and so
`pnpm dev:mock`) connects to:

- No development tools: `MCP_QUERY='features=account,database,branching' pnpm dev:mock`
  (anything without `development`). `get_project_url` / `get_publishable_keys` are then unknown tools.
- Project-scoped server: `MCP_QUERY='project_ref=abcdefghijklmnopqrst' pnpm dev:mock`
  (the seeded parent project), so `project_id` is injected and dropped from
  tool inputs.

## Seed data

Orgs `acme` (pro plan, so a new project quotes $10/month and shows cost
confirmation) and `hobby` (free, $0 so no confirmation). Project
`abcdefghijklmnopqrst` ("Acme production") with a branch named `other`; use it
as `project_id` for `create_branch`. The advisors endpoints return sample
security and performance lints, so `show_issues` has warnings and errors to
show.

Each project's SQL runs against its own in-memory Postgres (PGlite), created
on first use with sample `customers` and `orders` tables, so `execute_sql`,
`show_query` and `show_row` work on real rows (try `customers` with key
`{"id": 3}`); `read_only` queries run as a read-only role.
The logs endpoint returns 60 sample events spread over the requested window,
shaped like the source the SQL names (`postgres_logs` gets severities, anything
else HTTP requests), whatever the rest of the SQL says. Unknown routes log `!! UNHANDLED ROUTE`
and return 404.
