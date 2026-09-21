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

To build the MCP server and watch for file changes:

```bash
cd packages/mcp-server-supabase
pnpm dev
```

Configure your MCP client to run the local build. You may need to restart the server in your MCP client after each change.

```json
{
  "mcpServers": {
    "supabase": {
      "command": "node",
      "args": [
        "/path/to/supabase-mcp/packages/mcp-server-supabase/dist/transports/stdio.js",
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

Optionally, configure `--api-url` to point at a different Supabase instance (defaults to `https://api.supabase.com`)

## Testing

Run the commands below from the repository root. Outside CI, the Supabase package's `vitest.setup.ts` calls `statSync` on `packages/mcp-server-supabase/.env.local` before loading it. Create that file if it is missing; an empty file is sufficient for mocked unit tests. Do not set `CI=1` to bypass this prerequisite.

```bash
pnpm test              # unit and integration suites for all three packages
pnpm test:coverage     # mcp-server-supabase, with coverage
```

For the Supabase package's unit tests:

```bash
pnpm --filter @supabase/mcp-server-supabase test:unit --run
pnpm --filter @supabase/mcp-server-supabase test:unit --run src/server.database.test.ts
pnpm --filter @supabase/mcp-server-supabase test:unit --run src/server.database.test.ts -t "composite FK"
pnpm --filter @supabase/mcp-server-supabase test:unit --run src/server
```

These select all unit tests, the database suite, its composite-FK cases, and all six server suites, respectively. Full test and coverage runs also include integration/e2e tests: the stdio integration test needs a fresh package build, and e2e tests make real Anthropic requests using `ANTHROPIC_API_KEY`. An empty `.env.local` does not satisfy those requirements. Use existing authorized credentials, never commit them, and report missing prerequisites as blocked rather than a passing check.

### Where tests belong

Start in the existing test file closest to the behavior. Keep pure-helper tests colocated with their implementation; do not automatically add a file for each tool or case. For MCP behavior, use these suites under `packages/mcp-server-supabase/`:

| File | Responsibility |
| --- | --- |
| `src/server.test.ts` | Initialization, tool surface/schema contracts, feature groups, project scoping, docs and registry regressions |
| `src/server.account.test.ts` | Organizations, pricing, ordinary project creation/lifecycle, URLs and API keys |
| `src/server.database.test.ts` | SQL, migrations, tables/FKs/extensions and database permissions |
| `src/server.branching.test.ts` | Ordinary branch creation/lifecycle, listing, merge, reset and rebase |
| `src/server.project-services.test.ts` | Edge functions, storage, logs and advisors |
| `src/server.cost-confirmation.test.ts` | Project and branch cost confirmation, legacy fallback, modern elicitation, approval, token, retry and tamper flows |

Ordinary creation belongs with its domain; approval behavior belongs in cost confirmation. HTTP transport behavior belongs in `src/transports/http.test.ts`. Keep integration/e2e tests in their existing locations and projects.

Share repeated stream setup through `test/server-harness.ts`, but keep requests, SQL and assertions explicit. Each suite resets the harness once in `beforeEach` and awaits `close` in `afterEach`, including when setup fails. `setup` connects a client without resetting state, so fixtures created before setup survive and multiple connections within one test share state. Do not use `test.concurrent` with the shared mock maps and MSW server.

For ordinary healthy projects, `createProjectFixture` returns a free organization and its healthy project. Use the original factories for tests of pricing, creation/status transitions or approval behavior rather than hiding those inputs in a fixture.

This self-contained example uses the imports for a server suite under `src/`; when adding a case to an existing suite, reuse its harness and hooks:

```ts
import { afterEach, beforeEach, expect, test } from 'vitest';
import { createProjectFixture } from '../test/mocks.js';
import { createServerHarness } from '../test/server-harness.js';

const harness = createServerHarness();

beforeEach(() => {
  harness.reset();
});

afterEach(async () => {
  await harness.close();
});

test('returns the project URL', async () => {
  const { project } = await createProjectFixture();
  const { callTool } = await harness.setup();

  const result = await callTool({
    name: 'get_project_url',
    arguments: { project_id: project.id },
  });

  expect(result).toEqual({ url: `https://${project.id}.supabase.co` });
});
```

`callTool` accepts registered tool names and parses the first text result. `setup` also returns the raw `client`: use `client.callTool` for unknown or malformed calls and other raw protocol assertions. Let the harness own connection cleanup; do not close that client separately.

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
