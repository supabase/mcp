# @supabase/mcp-ui

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) views for the Supabase MCP server. Private: never published, only built.

Each view is a small React app under `src/views/<name>/`. `pnpm build` turns each one into a single self-contained HTML file, `dist/src/views/<name>/index.html` (imported as `@supabase/mcp-ui/<name>.html`), with all JS and CSS inlined by [`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile) (the setup the official MCP Apps examples use). `dist/` is gitignored.

`@supabase/mcp-server-supabase` imports those files as strings at build time (tsup's text loader) and serves them as `ui://supabase/<name>` resources. Hosts that support MCP Apps (Claude, ChatGPT, VS Code, MCP Inspector, …) render the view in a sandboxed iframe when the linked tool is called. Other clients just get the tool's normal text result.

Views talk to the host with the official SDK, [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) (`useApp`, `useHostStyles`, `app.callServerTool`, …).

## Develop a view

```bash
pnpm --filter @supabase/mcp-ui dev
```

Opens a mock host at `/dev/` that renders each view with canned tool input and results from `dev/fixtures.ts`. It uses the SDK's real host side (`AppBridge`), so no Supabase account or MCP server is needed, and views get HMR.

Add `?source=dist` to load the built HTML from `dist/` instead of the dev source.

## Test against the real server

Run the server with `pnpm dev:http` from the repo root (it also rebuilds views on change), then use [MCP Inspector](https://github.com/modelcontextprotocol/inspector), which is a full MCP Apps host. Views are off by default and only shown to modern-era clients that advertise MCP Apps, so add `?experimental_apps=true` to the URL and use the modern protocol:

```bash
# Check which tools have a UI and how it's configured (no browser needed)
npx @modelcontextprotocol/inspector --cli \
  --transport http --server-url "http://127.0.0.1:3111/mcp?experimental_apps=true" \
  --header "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  --protocol-era modern --advertise-apps \
  --method tools/list --app-info

# Open the web UI to call a tool and see its view rendered
npx @modelcontextprotocol/inspector --web
```

## Add a view

1. Create `src/views/<name>/index.html` and its React entry. `pnpm build` picks up every folder in `src/views/`.
2. In `packages/mcp-server-supabase/src/apps/index.ts`, import `@supabase/mcp-ui/<name>.html` and register it as a resource.
3. Link the tool to it with `_meta: { ui: { resourceUri } }` in its definition.
4. Add a fixture in `dev/fixtures.ts`.

Keep views small. The whole HTML is sent on every `resources/read`, so prefer system fonts and SVG icons, and avoid heavy dependencies unless a view really needs them.
