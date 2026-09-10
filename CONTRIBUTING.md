# Contributing

Before opening an issue or PR, please read this guide.

- **Issues** should describe a bug or feature request with context on why it matters. Issues that promote unaffiliated products or services will be closed.
- **PRs** should address an accepted issue. Open an issue first for new features or behavior changes so we can agree on the approach before you invest time coding. PRs that promote unaffiliated products or services will be closed.
- AI-assisted contributions are welcome, but a human must review and verify the output. Include verification steps and evidence (screenshots, test output, etc.) in the PR description.

## Development setup

This repo uses pnpm for package management and the active LTS version of Node.js. Node.js and pnpm versions are managed via [mise](https://mise.jdx.dev/) (see `mise.toml`).

> **Why mise?** We use mise to ensure all contributors use consistent versions of tools, reducing instances where code behaves differently on different machines. This is useful not only for managing Node.js and pnpm versions, but also binaries published outside of the npm ecosystem such as the [MCP Publisher CLI](https://modelcontextprotocol.io/registry/quickstart).

Clone the repo and run:

```bash
mise install
pnpm install
```

To run the MCP server locally over HTTP:

```bash
pnpm dev:http
```

Rebuilds and restarts on save. Flags pass through, e.g. `pnpm dev:http --api-url https://api.supabase.green`.

Example client config:

```json
{
  "mcpServers": {
    "supabase-local": {
      "type": "http",
      "url": "http://127.0.0.1:3111/mcp?project_ref=<your project ref>",
      "headers": { "Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}" }
    }
  }
}
```

The dev server supports the same [query params as the hosted endpoint](https://supabase.com/docs/guides/ai-tools/mcp#configuration-options). The access token comes from the client's `Authorization` header on each request. Restart the server in your MCP client after each change.

Add `--oauth` to skip the PAT: the dev server advertises itself as an OAuth-protected resource (the same model as the hosted endpoint), and each MCP client is meant to sign in with Supabase OAuth in its own browser popup on connect and attach its own token to every request. **Not yet usable against production**: the client SDK sends this loopback URL as the OAuth `resource` parameter, and `api.supabase.com` currently rejects any `resource` that isn't the exact hosted MCP endpoint — the authorize call fails with `400` until platform widens that validation to accept loopback `/mcp` URLs. Verified end to end against a local mock authorization server only; no token has been exchanged with the real Supabase authorization server yet.

Flags: `--http`, `--port` (default 3111), `--oauth`, `--api-url`, `--content-api-url`, `--version`.

To try the HTTP entry from a PR without cloning, run the preview build published by pkg.pr.new:

```bash
npx https://pkg.pr.new/@supabase/mcp-server-supabase@<sha> --http
```

### Alternative: stdio

The stdio transport is available without `--http`. Configure your MCP client to run the local build directly:

```json
{
  "mcpServers": {
    "supabase": {
      "command": "node",
      "args": [
        "/path/to/supabase-mcp/packages/mcp-server-supabase/dist/cli.js",
        "--project-ref",
        "<your project ref>"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "<your pat>"
      }
    }
  }
}
```

## Testing

```bash
pnpm test              # unit and integration suites for all three packages
pnpm test:coverage     # mcp-server-supabase, with coverage
```

### Packaging gates

`scripts/` holds checks that span more than one package and run outside the pnpm workspace. `pnpm test:packed-platform-consumer` packs `@supabase/mcp-server-supabase` together with its workspace dependency `@supabase/mcp-utils`, installs both from real tarballs with plain `npm` in a temporary project, and drives the public surface there. Workspace resolution (`workspace:`, `catalog:`, symlinked `node_modules`) cannot reach that project, which is what makes it a test of the published artifact rather than of the checkout.

Add a script here when a check needs more than one package, or needs to run from outside the workspace. Anything scoped to a single package belongs in that package's own `test` script.

## Releases

Releases are automated via [release-please](https://github.com/googleapis/release-please). It tracks commits on `main` and opens a release PR when there are releasable changes (`fix:` or `feat:`). Merging that PR:

1. Creates a GitHub release and git tag for each package
2. Publishes updated packages to npm
3. Publishes the MCP server to the [MCP registry](https://registry.modelcontextprotocol.io)

Most contributors don't need to do anything beyond merging the release PR and updating downstream apps.

If the release PR gets into a bad state, close it and manually re-run the workflow from the [Actions tab](https://github.com/supabase/mcp/actions/workflows/release.yml) → **Run workflow**. release-please will recreate the PR from scratch.

If the workflow creates GitHub releases and tags but fails before publishing to npm or the MCP registry, re-run the workflow from one of the release tags created by the failed workflow run and enable `force_publish`.

## Breaking changes

Treat `tools/list` as a public API contract.

ChatGPT snapshots MCP metadata during plugin submission. Several fields are frozen for published ChatGPT users until a new plugin version is published, including:

- Tool list, names, titles, and descriptions
- Input and output schemas
- Tool annotations
- Tool `_meta` fields
- MCP server `instructions`

See OpenAI's [Ongoing Maintenance](https://developers.openai.com/apps-sdk/deploy/submission#ongoing-maintenance) docs for a more complete overview of frozen fields.

Claude Connectors don't have this constraint, and will pick up server changes on the next connection without needing resubmission ([docs](https://claude.com/docs/connectors/building/after-publishing#update-your-mcp-server)).

**Keep breaking changes backward compatible**

Follow the [expand and contract pattern](https://martinfowler.com/bliki/ParallelChange.html) (aka Parallel Change):

- **Expand:** add new tools/fields alongside the old ones. New fields must be optional, so clients still on the frozen schema keep validating. Don't touch the optionality of existing fields.
- **Contract:** only remove the old tools/fields once the new version is published, so no frozen client can still depend on them.

**Version the break at contract, not expand**

The expand step adds things without removing anything, so it's safe to release as a normal `feat`/`fix` commit - nothing that already worked stops working. The contract step is the one that actually removes a tool/field, so that's where the real break happens: mark that commit accordingly (e.g. `feat!:` or a `BREAKING CHANGE:` footer) so the changelog and version bump reflect it, even though the wire-level (`tools/list`) change may have quietly landed one or more releases earlier at expand time.

**Deprecating a tool**

1. **Expand:** add the replacement tool, then mark the old one `hidden: true` (with a comment noting its replacement) instead of removing it right away:

   ```ts
   export const someToolDefs = {
     new_tool: { ... },
     old_tool: {
       ...,
       hidden: true, // replaced by new_tool, remove once a new ChatGPT submission has gone out
     },
   } satisfies ToolDefs;
   ```

   This drops the old tool from `tools/list` for live clients while keeping it fully callable via `tools/call`, so the frozen ChatGPT plugin keeps working.

2. **Contract:** once a new ChatGPT plugin submission has gone out, delete the old tool definition entirely.

**Update docs when the MCP surface changes**

[supabase.com/mcp](https://supabase.com/mcp) owns the canonical tool list, update it as needed for changes to tools or configuration options. [Agent skills](https://github.com/supabase/agent-skills) should generally reference MCP workflows instead of specific tool names, but double check for wording when names or behavior change.

**Update the ChatGPT plugin submission when published metadata changes**

Create a new plugin submission via the [OpenAI plugin dashboard](https://platform.openai.com/plugins). Note the submission file can contain sensitive test credentials, so prefer making updates by hand.

Server-only fixes that preserve the published contract don't need resubmission.

If a deployed change breaks the published ChatGPT contract, roll back the server change rather than waiting on review.

## Manual MCP registry publish (optional)

This is only needed if the automated publish failed or needs to be re-run manually. The MCP registry stores metadata about the server (defined in `packages/mcp-server-supabase/server.json`) — it does not host the server itself.

### Dependencies

You will need `mcp-publisher` installed. It's already pinned in `mise.toml`, so if you have mise set up just run:

```bash
mise install
```

### Steps

1. Update `server.json` with the new version by running:

   ```shell
   pnpm registry:update
   ```

2. Download the `domain-verification-key.pem` from Bitwarden and place it in `packages/mcp-server-supabase/`. This will be used to verify ownership of the `supabase.com` domain during the login process.

   > This works because of the [`.well-known/mcp-registry-auth`](https://github.com/supabase/supabase/blob/master/apps/www/public/.well-known/mcp-registry-auth) endpoint served by `supabase.com`.

3. Login to the MCP registry:

   ```shell
   pnpm registry:login
   ```

4. Publish:

   ```shell
   pnpm registry:publish
   ```
