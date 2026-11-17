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

## Styling

Views are themed by the host first. `useHostStyles` applies the host's theme and MCP Apps style variables (`--color-text-primary`, `--font-sans`, `--border-radius-md`, …), and every rule reads those variables directly. `src/shared/styles.css` declares a fallback for each one, taken from the Supabase design system, which applies only when the host omits it. Dark mode is `light-dark()` in those fallbacks, following the host's theme.

The stylesheet is plain CSS in cascade layers, `@layer base, native, components, view, utilities`: tokens and root styles, bare elements, shared components, per-view overrides under a view's wrapper class, then the few rules that must win over everything (`.sr-only`). Each layer has a specificity cap, and anything past it goes in `:where()`, so later layers always win without heavier selectors or `!important`. Components use one class per element, with parts as `data-slot` and state as `data-state` or `data-tone`.

The full rules are in [`.agents/skills/mcp-ui-css/SKILL.md`](.agents/skills/mcp-ui-css/SKILL.md). `pnpm lint:css` checks them (it also runs before `pnpm build`).

## Add a view

1. Create `src/views/<name>/index.html` and its React entry. `pnpm build` picks up every folder in `src/views/`. The view's root element is a wrapper with the class `<name>-view` (e.g. `<div className="create-project-view">`), which scopes any view-specific CSS (see [Styling](#styling)).
2. In `packages/mcp-server-supabase/src/resources/app-resources.ts`, import `@supabase/mcp-ui/<name>.html` and register it as a resource.
3. Link the tool to it with `_meta: { ui: { resourceUri } }` in its definition.

Keep views small. The whole HTML is sent on every `resources/read`, so prefer system fonts and SVG icons, and avoid heavy dependencies unless a view really needs them.
