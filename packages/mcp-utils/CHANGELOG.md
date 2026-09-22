# Changelog

## [0.8.0](https://github.com/supabase/mcp/compare/mcp-utils-v0.7.0...mcp-utils-v0.8.0) (2026-09-04)


### Features

* **mcp:** add project cost confirmation elicitation ([#391](https://github.com/supabase/mcp/issues/391)) ([fb50882](https://github.com/supabase/mcp/commit/fb5088279b6fdc4f3049400b1f1da393fd83e2fb))
* **mcp:** hide legacy cost tools from form-capable clients ([#411](https://github.com/supabase/mcp/issues/411)) ([2f04461](https://github.com/supabase/mcp/commit/2f04461fda022d1bde326310e641be87fccbb90c))

## [0.7.0](https://github.com/supabase/mcp/compare/mcp-utils-v0.6.0...mcp-utils-v0.7.0) (2026-08-20)


### ⚠ BREAKING CHANGES

* the peer dependency is now `@modelcontextprotocol/server` instead of `@modelcontextprotocol/sdk`, so consumers must install the new package. `@supabase/mcp-utils` also drops the exported types `ExtractRequest`, `ExtractNotification`, `ExtractResult` and `ExpandRecursively`, and `createMcpServer` returns a bare `Server` rather than `Server<Request, Notification, Result>`, because v2's `Server` class takes no type parameters. Because that returned value is now a v2 `Server`, a consumer who registered extra handlers on it must rewrite `server.setRequestHandler(SomeRequestSchema, ...)` as `server.setRequestHandler('some/method', ...)`; the v1 Zod-schema overload no longer exists. `InitData.clientCapabilities` now follows v2's `ClientCapabilities`, which is narrower than v1's and not assignable from it. Finally, a `tools/call` request whose `params` are malformed, meaning no `name` key or a non-string `name`, now returns JSON-RPC `-32602` with the message prefix `Invalid tools/call request: ` where v1 returned `-32603` with a bare stringified ZodError.

### Features

* migrate published packages to MCP SDK v2 ([#327](https://github.com/supabase/mcp/issues/327)) ([ead56f2](https://github.com/supabase/mcp/commit/ead56f228fcc316dd7d8db9030807fb7b3bfb73b))

## [0.6.0](https://github.com/supabase/mcp/compare/mcp-utils-v0.5.1...mcp-utils-v0.6.0) (2026-08-10)


### Features

* hide tools from tools/list ([#334](https://github.com/supabase/mcp/issues/334)) ([d80471a](https://github.com/supabase/mcp/commit/d80471a13b9ceafbdadfec30a0d38c80baa7e718))

## [0.5.1](https://github.com/supabase/mcp/compare/mcp-utils-v0.5.0...mcp-utils-v0.5.1) (2026-06-05)


### Bug Fixes

* update repo URLs after `supabase/mcp` transfer ([#295](https://github.com/supabase/mcp/issues/295)) ([71e48cc](https://github.com/supabase/mcp/commit/71e48cce0350e1b53191e8a0f9c6120314e4fcc1))

## [0.5.0](https://github.com/supabase-community/supabase-mcp/compare/mcp-utils-v0.4.0...mcp-utils-v0.5.0) (2026-04-30)


### Features

* server instructions ([17fb90f](https://github.com/supabase-community/supabase-mcp/commit/17fb90f8655ad1ce7ee320614d22eb68bb26e510))
* server instructions ([6e39c6f](https://github.com/supabase-community/supabase-mcp/commit/6e39c6f9885f639b98c6d5759215ce9391737f6e))
