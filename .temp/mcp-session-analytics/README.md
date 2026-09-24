# MCP product analytics report

This folder builds a self-contained product analytics dashboard for Supabase MCP. It keeps the approved synthetic workflow model separate from the aggregate production Logflare baseline.

## Try the local HTTP MCP server

Install the repository dependencies first:

```bash
mise install
pnpm install
```

Install the report runner with its isolated lockfile:

```bash
pnpm --dir .temp/mcp-session-analytics install --frozen-lockfile --ignore-workspace
```

The isolated install does not update the workspace lockfile.

Start the local HTTP server from the repository root:

```bash
pnpm dev:http
```

In a second terminal, verify the read-only MCP surface:

```bash
pnpm --dir .temp/mcp-session-analytics run smoke:http
```

The smoke client connects to `http://127.0.0.1:3111/mcp?read_only=true`, calls `tools/list`, and checks for `list_projects` and `search_docs`. It refuses non-loopback URLs and does not invoke product tools.

To use another local port:

```bash
MCP_URL=http://127.0.0.1:4311/mcp pnpm --dir .temp/mcp-session-analytics run smoke:http
```

After the PR preview package is available, the same check works against it:

```bash
npx https://pkg.pr.new/@supabase/mcp-server-supabase@<sha> --http
pnpm --dir .temp/mcp-session-analytics run smoke:http
```

## Build and check the dashboard

```bash
pnpm --dir .temp/mcp-session-analytics run generate
pnpm --dir .temp/mcp-session-analytics run check
```

Open `.temp/mcp-session-analytics/report.html` in a browser.

`generate` writes two deterministic artifacts:

- `evidence.json`: sanitized aggregate inputs only
- `report.html`: the self-contained dashboard

`check` verifies deterministic output, required dashboard views, the visible session disclaimer, the inline favicon, and privacy rules. It writes the result to `verification.json`.

## Data boundary

The report uses three labeled sources:

- Production aggregate: 28-day metrics from `mcp.logs.prod`
- Synthetic model: a fixed 2,400-session intent and workflow set
- Validated handles: controlled explicit-session checks

The report does not contain raw arguments, responses, SQL, project references, user IDs, auth values, or raw error text.
