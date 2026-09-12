# Changelog

## [0.13.0](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.12.0...mcp-server-supabase-v0.13.0) (2026-09-12)


### Features

* add --http local HTTP entry to mcp-server-supabase ([#401](https://github.com/supabase/mcp/issues/401)) ([ff063b4](https://github.com/supabase/mcp/commit/ff063b44a934c3b9d0b7bc54370aaa8ff168c1de))
* **management:** add v2 api client ([#419](https://github.com/supabase/mcp/issues/419)) ([02ca542](https://github.com/supabase/mcp/commit/02ca54273202ac8de5a7d7b6b5d1a2c8800b1374))


### Bug Fixes

* discourage host-filesystem access in raw-SQL tool descriptions ([#410](https://github.com/supabase/mcp/issues/410)) ([641ed1e](https://github.com/supabase/mcp/commit/641ed1ef09dbd0597dd53e763ab80c7a1209e0c3))

## [0.12.0](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.11.0...mcp-server-supabase-v0.12.0) (2026-09-04)


### Features

* group lints in `get_advisors` response ([#390](https://github.com/supabase/mcp/issues/390)) ([48d593a](https://github.com/supabase/mcp/commit/48d593adeb0401e547caee4cdca5258cd7410ab1))
* **mcp:** add branch cost confirmation elicitation ([#394](https://github.com/supabase/mcp/issues/394)) ([867a160](https://github.com/supabase/mcp/commit/867a1609d7dd215faf0cf7fcc44737d6304b8307))
* **mcp:** add project cost confirmation elicitation ([#391](https://github.com/supabase/mcp/issues/391)) ([fb50882](https://github.com/supabase/mcp/commit/fb5088279b6fdc4f3049400b1f1da393fd83e2fb))
* **mcp:** hide legacy cost tools from form-capable clients ([#411](https://github.com/supabase/mcp/issues/411)) ([2f04461](https://github.com/supabase/mcp/commit/2f04461fda022d1bde326310e641be87fccbb90c))


### Bug Fixes

* ensure correct escaping in advisor ([#407](https://github.com/supabase/mcp/issues/407)) ([a6cf4a0](https://github.com/supabase/mcp/commit/a6cf4a02c5b6427a2afdc1f031ed85498d51c336))
* make server instructions intent-based instead of naming tools ([#372](https://github.com/supabase/mcp/issues/372)) ([fc54ea2](https://github.com/supabase/mcp/commit/fc54ea291e7c43e4501d8198d756d2c86a14538a))

## [0.11.0](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.10.0...mcp-server-supabase-v0.11.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* the peer dependency is now `@modelcontextprotocol/server` instead of `@modelcontextprotocol/sdk`, so consumers must install the new package. `@supabase/mcp-utils` also drops the exported types `ExtractRequest`, `ExtractNotification`, `ExtractResult` and `ExpandRecursively`, and `createMcpServer` returns a bare `Server` rather than `Server<Request, Notification, Result>`, because v2's `Server` class takes no type parameters. Because that returned value is now a v2 `Server`, a consumer who registered extra handlers on it must rewrite `server.setRequestHandler(SomeRequestSchema, ...)` as `server.setRequestHandler('some/method', ...)`; the v1 Zod-schema overload no longer exists. `InitData.clientCapabilities` now follows v2's `ClientCapabilities`, which is narrower than v1's and not assignable from it. Finally, a `tools/call` request whose `params` are malformed, meaning no `name` key or a non-string `name`, now returns JSON-RPC `-32602` with the message prefix `Invalid tools/call request: ` where v1 returned `-32603` with a bare stringified ZodError.

### Features

* add dual-era package serving entries ([#358](https://github.com/supabase/mcp/issues/358)) ([989eb4e](https://github.com/supabase/mcp/commit/989eb4e8e392305510e3aa119855bab0e2bd3bdb))
* migrate published packages to MCP SDK v2 ([#327](https://github.com/supabase/mcp/issues/327)) ([ead56f2](https://github.com/supabase/mcp/commit/ead56f228fcc316dd7d8db9030807fb7b3bfb73b))

## [0.10.0](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.9.0...mcp-server-supabase-v0.10.0) (2026-08-10)


### ⚠ BREAKING CHANGES

* add query_logs tool for custom log queries ([#333](https://github.com/supabase/mcp/issues/333))

### Features

* add --content-api-url flag and SUPABASE_CONTENT_API_URL env var ([#343](https://github.com/supabase/mcp/issues/343)) ([6fcaaa3](https://github.com/supabase/mcp/commit/6fcaaa39061545d21aeae9f19672437f4b1f617d))
* add query_logs tool for custom log queries ([#333](https://github.com/supabase/mcp/issues/333)) ([798806b](https://github.com/supabase/mcp/commit/798806b4a4c132be39d5578a77186ad0e5e4c875))
* hide tools from tools/list ([#334](https://github.com/supabase/mcp/issues/334)) ([d80471a](https://github.com/supabase/mcp/commit/d80471a13b9ceafbdadfec30a0d38c80baa7e718))


### Bug Fixes

* hide read-only mode ([#349](https://github.com/supabase/mcp/issues/349)) ([5cda067](https://github.com/supabase/mcp/commit/5cda0672702c65fe672280ee4cf306593e643fb6))
* **pg-meta:** pair composite FK columns positionally to avoid cartesi… ([#317](https://github.com/supabase/mcp/issues/317)) ([10af00b](https://github.com/supabase/mcp/commit/10af00bbce7ff1dc116be36a78670119220fb2da))
* select query_logs dialect via logsDialect ([#357](https://github.com/supabase/mcp/issues/357)) ([80ff453](https://github.com/supabase/mcp/commit/80ff4538afe5385db6c896fe851c4f5b7f66eb3b))

## [0.9.0](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.8.3...mcp-server-supabase-v0.9.0) (2026-07-16)


### Features

* support edge function runtime logs in get_logs ([#326](https://github.com/supabase/mcp/issues/326)) ([b9675aa](https://github.com/supabase/mcp/commit/b9675aabee68ea703565e06a1887a95dd2124f77))

## [0.8.3](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.8.2...mcp-server-supabase-v0.8.3) (2026-07-15)


### Bug Fixes

* actionable error for wrong-org permission failures on database tools ([#329](https://github.com/supabase/mcp/issues/329)) ([add45f5](https://github.com/supabase/mcp/commit/add45f53d83e452ca9d4b338b2990fb629e46cba))

## [0.8.2](https://github.com/supabase/mcp/compare/mcp-server-supabase-v0.8.1...mcp-server-supabase-v0.8.2) (2026-06-05)


### Bug Fixes

* **test:** resolve edge function test typo and invalid branch array access ([#279](https://github.com/supabase/mcp/issues/279)) ([da182d6](https://github.com/supabase/mcp/commit/da182d6633f7ae5144abfdb9a9b168d882bfc03f))
* update repo URLs after `supabase/mcp` transfer ([#295](https://github.com/supabase/mcp/issues/295)) ([71e48cc](https://github.com/supabase/mcp/commit/71e48cce0350e1b53191e8a0f9c6120314e4fcc1))

## [0.8.1](https://github.com/supabase-community/supabase-mcp/compare/mcp-server-supabase-v0.8.0...mcp-server-supabase-v0.8.1) (2026-05-01)


### Bug Fixes

* tools not loading on stdio server ([#269](https://github.com/supabase-community/supabase-mcp/issues/269)) ([29acd6c](https://github.com/supabase-community/supabase-mcp/commit/29acd6c6efca82d1e1d2b55c160b74beb8dcc6ab)), closes [#261](https://github.com/supabase-community/supabase-mcp/issues/261)

## [0.8.0](https://github.com/supabase-community/supabase-mcp/compare/mcp-server-supabase-v0.7.0...mcp-server-supabase-v0.8.0) (2026-04-30)


### Features

* extra validation to platform schemas ([faac42b](https://github.com/supabase-community/supabase-mcp/commit/faac42b9527159476fd7702f29a9c34018707934))
* extra validation to platform schemas ([06e66c5](https://github.com/supabase-community/supabase-mcp/commit/06e66c5f3e5d8e526a33d3632e0391177daf86fa))
* inject RLS advisory into list_tables response ([7f80119](https://github.com/supabase-community/supabase-mcp/commit/7f8011987c4800acb83e005ea6f5287d686a853a))
* inject RLS advisory into list_tables response ([9d9ce76](https://github.com/supabase-community/supabase-mcp/commit/9d9ce7615047b22cef6929437bad81c30a7bc711))
* remove cost confirmation mention in instructions ([dc376b9](https://github.com/supabase-community/supabase-mcp/commit/dc376b90407b7be1f453e0efee6b8c9134790888))
* server instruction test ([24908e9](https://github.com/supabase-community/supabase-mcp/commit/24908e9f03a6130ed52935e459ace1da30f47678))
* server instructions ([17fb90f](https://github.com/supabase-community/supabase-mcp/commit/17fb90f8655ad1ce7ee320614d22eb68bb26e510))
* server instructions ([6e39c6f](https://github.com/supabase-community/supabase-mcp/commit/6e39c6f9885f639b98c6d5759215ce9391737f6e))


### Bug Fixes

* sync management API types and add slug to list_organizations output ([#234](https://github.com/supabase-community/supabase-mcp/issues/234)) ([755b5db](https://github.com/supabase-community/supabase-mcp/commit/755b5db6b849d1a6e60e3e51aa02b767bdb5394a))
* update RLS advisory message for clarity and user guidance ([bbc2131](https://github.com/supabase-community/supabase-mcp/commit/bbc2131cec7b8c4e69db4ba2359ebc2c675ae591))
