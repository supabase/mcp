# @supabase/mcp-ui

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) views for the Supabase MCP server. Private: never published, only built.

Each view is a small React app under `src/views/<name>/`. `pnpm build` turns each one into a single self-contained HTML file, `dist/src/views/<name>/index.html` (imported as `@supabase/mcp-ui/<name>.html`), with all JS and CSS inlined by [`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile) (the setup the official MCP Apps examples use). `dist/` is gitignored.

`@supabase/mcp-server-supabase` imports those files as strings at build time (tsup's text loader) and serves them as `ui://supabase/<name>` resources. Hosts that support MCP Apps (Claude, ChatGPT, VS Code, MCP Inspector, …) render the view in a sandboxed iframe when the linked tool is called. Other clients just get the tool's normal text result.

Views talk to the host with the official SDK, [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) (`useApp`, `useHostStyles`, `app.callServerTool`, …).

## Develop a view

Views render in [MCP Inspector](https://github.com/modelcontextprotocol/inspector), a full MCP Apps host. From the repo root, in two terminals:

```bash
pnpm dev:http                              # rebuilds views and restarts the server on change
SUPABASE_ACCESS_TOKEN=<your pat> pnpm inspector
```

`pnpm inspector` opens the web UI already pointed at the dev server with `?experimental_apps=true`, your token and the modern protocol, since views are only shown to modern-era clients that advertise MCP Apps. Connect, then open the Apps tab. Inspector caches view HTML per connection, so reconnect after a change.

### Visually test scenarios with the mock API

To see a view's progress, failure and timeout states without a Supabase account, run the mock Management API, the dev server pointed at it, and Inspector together with one command from the repo root:

```bash
pnpm dev:mock   # Ctrl-C stops all three; MOCK_API_PORT / MOCK_TOKEN override the defaults, extra args go to dev:http
MCP_QUERY='project_ref=abcdefghijklmnopqrst' pnpm dev:mock   # extra query params for the MCP URL Inspector connects to
```

Or run them yourself in three terminals:

```bash
pnpm mock-api                              # fake Management API on http://localhost:4010
pnpm dev:http --api-url http://localhost:4010 --secret-url-template 'http://localhost:4010/mcp/secrets?ref={ref}&name={name}'
SUPABASE_ACCESS_TOKEN=mock pnpm inspector  # any bearer token works with the mock
```

`pnpm inspector` targets the `pnpm dev:http` server on `127.0.0.1:3111`, and `dev:http` forwards the extra flags to the server, so Inspector connects the same way as against the real API. Switch scenarios at runtime, then call the tool again:

```bash
curl -X POST localhost:4010/__scenario -d '{"name":"create-project:init-failed"}'
```

The scenario list and other endpoints are in [`packages/mcp-server-supabase/dev/README.md`](../mcp-server-supabase/dev/README.md).

## Styling

Views are themed by the host first. `useHostStyles` applies the host's theme and MCP Apps style variables (`--color-text-primary`, `--font-sans`, `--border-radius-md`, …), and rules read the font, radius and border-width variables directly. Colours go through Studio's semantic tokens (`--sb-color-foreground`, `--sb-color-border`, …), which a bridge in `src/shared/base.css` maps from the host's colour variables, so components can move into Studio unchanged. Every variable has a fallback there, taken from the Supabase design system, which applies only when the host omits it. Dark mode is `light-dark()` in those fallbacks, following the host's theme.

The CSS is plain, in cascade layers, `@layer base, native, components, view, utilities`: tokens and root styles, bare elements, shared components, a view's own overrides (in its `view.css`), then the few rules that must win over everything (`.sr-only`). `base.css` holds `base`, `native` and `utilities`, and every view imports it first. Each shared component keeps its `components` rules in its own file (`src/shared/badge.css`) and imports it, so a view only ships the CSS of the components it imports. Vite keeps CSS imports as side effects, so importing a component ships its CSS even if the view never renders it. Each layer has a specificity cap, and anything past it goes in `:where()`, so later layers always win without heavier selectors or `!important`. Components use one class per element, with parts as `data-slot` and state as `data-state` or `data-tone`. A component's custom properties are namespaced after its file (`--sb-component-project-card-*` in `project-card.css`); reading another component's property needs a `var()` fallback, because a view may ship one file without the other.

The full rules are in [`.agents/skills/mcp-ui-css/SKILL.md`](.agents/skills/mcp-ui-css/SKILL.md). `pnpm lint:css` checks them (it also runs before `pnpm build`).

## Add a view

1. Create `src/views/<name>/index.html` and its React entry. `pnpm build` picks up every folder in `src/views/`. If the view needs CSS of its own, add `src/views/<name>/view.css` (see [Styling](#styling)).
2. In `packages/mcp-server-supabase/src/resources/app-resources.ts`, import `@supabase/mcp-ui/<name>.html` and register it as a resource.
3. Link the tool to it with `_meta: { ui: { resourceUri } }` in its definition.

### Always shown, or a `show_*` tool

Decide whether the user wants the view every time the tool runs:

- **Every call** (`create_project`, `create_branch`): link the existing tool to the view. The view reads the tool's normal result.
- **Only when asked** (query results, a row, logs): the model reads data with its usual tools (`execute_sql`, `query_logs`) without putting a view in front of the user. Add a separate `show_<thing>` tool for the view, and add its name to `VIEW_TOOLS` in `packages/mcp-server-supabase/src/apps/index.ts` so clients without MCP Apps don't list it. It returns a short summary for the model and puts what the view shows in the result's `_meta` under `VIEW_DATA_META_KEY`, which `useMcpView` reads in place of the text result. Actions in the view call the usual tools (`callTool('execute_sql', …)`), so the server's permissions and confirmations still apply.

### Let the agent work in a view

A view that the user and the agent work in together uses `src/shared/view-agent.ts`, which routes to whatever the host supports:

- **Tools.** Define each once with `viewTool` and register them with `registerViewTools` in `useMcpView`'s `onAppCreated` (before the handshake). They're offered as MCP Apps view tools (`app.registerTool`) for Claude, and over WebMCP (`document.modelContext.registerTool`) for ChatGPT and Codex desktop, which don't support `app.registerTool` (see the [OpenAI MCP Extensions spec](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md) and its Bits & Bolts plugin). A host with neither just shows the view.
- **Context.** `createContextSharer` sends what the view shows through `ui/update-model-context`, where the host supports it. It's one stream per view, labelled as data and titled for ChatGPT (`openai/title`).

Each view keeps its own side in a file beside it:
- `query-block-agent.ts`: `read_query` and `set_query_draft`. Edits pass the revision they read, so they never overwrite the user's typing, and they never run SQL: the user does.
- `logs-agent.ts`: `read_logs` (the filters and the events the user selected, never the others) and `configure_logs` (changes the filters as the user would).

Tools carry the view's id (the host's tool call id), so a conversation with several views changes the right one.

Keep views small. The whole HTML is sent on every `resources/read`, so prefer system fonts and SVG icons, and avoid heavy dependencies unless a view really needs them.
