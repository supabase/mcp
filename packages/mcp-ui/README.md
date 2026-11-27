# @supabase/mcp-ui

[MCP Apps](https://modelcontextprotocol.io/extensions/apps/overview) views for the Supabase MCP server. Private: never published, only built.

Each view is a small React app under `src/views/<name>/`. `pnpm build` turns each one into a single self-contained HTML file, `dist/src/views/<name>/index.html` (imported as `@supabase/mcp-ui/<name>.html`), with all JS and CSS inlined by [`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile) (the setup the official MCP Apps examples use). `dist/` is gitignored.

`@supabase/mcp-server-supabase` imports those files as strings at build time (tsup's text loader) and serves them as `ui://supabase/<name>` resources. Hosts that support MCP Apps (Claude, ChatGPT, VS Code, MCP Inspector, …) render the view in a sandboxed iframe when the linked tool is called. Other clients just get the tool's normal text result.

Views talk to the host with the official SDK, [`@modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps) (`useApp`, `useHostStyles`, `app.callServerTool`, …).

## Views

| View | Tool | What it shows |
| --- | --- | --- |
| `create-project` | `create_project` | The new project's card, kept live while it sets up |
| `create-branch` | `create_branch` | The same card for a branch |
| `show-issues` | `show_issues` | A project's issues, five to a page, to select and hand to the assistant with "Review selected issues (N)" |

`show-issues` is split into layers, each knowing only the one below it: `issues-schema.ts` and `issues-client.ts` read the server's results (never cast: the view and the server can be different versions), `issues-list.ts`, `selection.ts`, `handoff.ts` and `prompts.ts` hold the logic without React, `use-issues.ts` runs it and is the only place that calls the host or catches errors, and the components (`IssuesList`, `IssueRow`, `SeverityIndicator`, `Pager`, `SelectionBar`) only draw props. It reads its first page from the result's `_meta` and pages further with `app_paginate_issues`. The mock API's `show-issues:*` scenarios cover many issues, none, a category that can't be read and a page that fails.

Each tool call mounts a new view, and the older copies stay live further up the chat. `src/shared/use-supersession.ts` retires them. Each view posts a stamp from its tool result, `{ key, at, id }` with `at` from the server's clock, on one shared `BroadcastChannel`, `supabase-mcp-views`. A view that hears a newer stamp with its key retires; one that hears an older stamp answers, so an old view that mounts late still learns it is old. The key is the view's name plus the project ref, so only views of the same kind and project retire each other. A view opts in by passing its key and stamp. A retired `show-issues` view shows only a notice that points to the newer view, clears what it shared with the model and disables its view tool.

### View tools

A view gives the tools the model can call to `useMcpView`'s `tools`: a function that returns each tool's name, description, handler and, once it should be hidden, `disabled`. `useMcpView` registers them once, before the view connects so the handshake declares them, and calls the function again after every render, so a call runs the latest handler and a tool stays disabled once a render disables it. Underneath, `registerViewTool` from `src/shared/view-tools.ts` registers each one with `app.registerTool`, and with WebMCP (`document.modelContext`) where the browser has it, and returns one handle that disables both. It is the only vendor-specific code in the views, and it picks its path by feature detection, never by the host's name. Delete the WebMCP bridge when upgrading to `@modelcontextprotocol/ext-apps` 2.1.0, which mirrors to WebMCP itself. View tools are in the draft MCP Apps spec, so no view should depend on one.

`show-issues` registers `refresh_issues_view`. It reloads the list as Refresh does and returns one line, such as "Issues reloaded: 21 issues, was 23." It has no `app_` prefix: that marks a server tool only the view calls, and a view tool is the opposite, a tool the model calls.

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

A server tool that only a view calls is named with an `app_` prefix (`app_paginate_issues`) and sets `_meta: { ui: { visibility: ['app'] } }`, so the host lets the view call it but does not give it to the model.

Keep views small. The whole HTML is sent on every `resources/read`, so prefer system fonts and SVG icons, and avoid heavy dependencies unless a view really needs them.
