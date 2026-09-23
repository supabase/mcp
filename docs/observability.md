# Observability

The server provides an optional, vendor-neutral observer for five request-handler lifecycles and the existing cost-confirmation flow. It emits bounded facts without exposing request contents. No collection, host metrics, provider, exporter, queue, or host adoption is configured by this API.

## API and ownership

Set `observer?: RequestObserver` on `McpServerOptions` for `createMcpServer` or on `SupabaseMcpServerOptions` for `createSupabaseMcpServer`. `createSupabaseMcpHandler` inherits the same options.

Both `@supabase/mcp-utils` and `@supabase/mcp-server-supabase` export:

- `ObservedMethod`
- `ObservedTool`
- `ObservationContext`
- `ConfirmationFeature`
- `ObservationFact`
- `ObservationEnd`
- `RequestObservation`
- `RequestObserver`

`RequestObserver` is a synchronous factory. Invoking it begins observation. It receives `{ method, tool }` and returns a `RequestObservation` or `undefined`. Its returned observation methods are:

- `record(fact): void | Promise<void>`
- `end({ result, durationMs }): void | Promise<void>`

Only the handler owns `end`. Tool code receives an optional safe, synchronous recorder through the additive third argument to `Tool.execute(params, context, record?: (fact: ObservationFact) => void)`. Existing one- and two-argument callers continue to work; `injectableTool` forwards the recorder.

The observer factory must not return a Promise. An unsupported Promise return is discarded, with its rejection consumed.

## Request scope

| `ObservedMethod` | Tool classification |
| --- | --- |
| `tools/call` | `create_project`, `create_branch`, `execute_sql`, `apply_migration`, or `other` |
| `tools/list` | `not_applicable` |
| `resources/list` | `not_applicable` |
| `resources/templates/list` | `not_applicable` |
| `resources/read` | `not_applicable` |

Unknown tool names become `other`; raw names are not emitted. Initialize requests, notifications, unknown methods, and SDK rejections before handler entry do not create scopes.

Currently, `execute_sql` and `apply_migration` are general handler buckets only. They emit no confirmation or operation facts.

For `tools/call`, observation begins before tool lookup, name validation, and Zod validation. Each scope ends in `finally`, after response shaping and before transport. End results use this precedence:

1. `handler_error`: an error escapes the handler, including when shaping an error response itself throws.
2. `tool_error`: the direct result has `isError: true`, or a tool error (unknown tool, Zod validation failure, or `execute` throw) is caught and shaped into an error response.
3. `input_required`: the response requests input.
4. `declined` or `cancelled`: a terminal decline or cancel was consumed.
5. `completed`: none of the above applies.

The existing `resources/read` catch returns `isError: true`, so that path ends as `tool_error`. An escaping serialization error ends as `handler_error`.

Each retry or replay is a new attempt. There is no deduplication, flow identifier, cross-request state, abandonment timer, or abort-derived end result. `completed` describes handler completion, not completion of a multi-request confirmation flow.

### Durations

Handler `durationMs` uses a monotonic clock from handler entry through response shaping. It excludes SDK pre-entry validation, human wait between attempts, and transport. Timestamps are taken before the corresponding sink work.

Operation durations cover actual awaited protected calls, not the whole confirmation flow. `returned` does not prove readiness or commit; `threw` does not prove that nothing committed.

## Current facts: cost confirmation

`ConfirmationFeature` currently contains only `cost`. Every current fact has `feature: 'cost'`.

| `kind` | Fields and values |
| --- | --- |
| `confirmation_decision` | `route: inline \| legacy \| bypass \| blocked`; `reason: eligible \| not_configured \| capability_missing \| read_only \| zero_cost` |
| `input_required` | `mode: form`; `reason: initial \| missing_response \| changed_quote` |
| `input_response` | `action: accept \| decline \| cancel` |
| `resume_validation` | `result: valid \| missing_response \| tool_mismatch \| arguments_mismatch \| changed_quote` |
| `operation` | `disposition: started` |
| `operation` | `disposition: returned \| threw`; `durationMs: number` |

The decision pairs are:

- `blocked/read_only`.
- `legacy/not_configured`, checked before `legacy/capability_missing`.
- `inline/eligible`.
- Initial project-only `bypass/zero_cost`. Branch creation has no corresponding shortcut.

Modern resume validation, missing responses, changed quotes, and actions use the literal facts above. Legacy hash checks are not reported as modern resume validation.

All five actual protected project and branch call sites emit `operation/started`, followed by `operation/returned` or `operation/threw` with a duration. This includes legacy and zero-cost paths.

`checkConfirmationState` records `input_required` after the caller's `askForConfirmation` resolves, so issuance is recorded only when minting and response construction succeed. It does not establish delivery or display. `input_response/accept` records an action, not independently verified consent.

Observation does not change confirmation rules or execution behavior.

## Failure isolation and disabled behavior

- With no observer, there is no observation work: no scope, context, fact, clock, or Promise work.
- The factory is called synchronously once per handler entry. A Promise or thenable it returns is discarded; `record` and `end` results are never awaited. Throws, throwing getters, and rejections from the factory, `record`, or `end` are swallowed without logging or retry, including when a returned Promise's own `then` or `catch` is overridden or throws. Facts after `end` and duplicate `end` calls are ignored; delivery is not exactly-once.
- This is isolation, not a sandbox: a blocking synchronous sink still blocks, and global Promise tampering and hostile constructor or species access are outside the guarantee.

## Privacy and host responsibilities

Observer DTOs contain finite literal values and numeric durations only. They exclude raw arguments, results, SQL, errors, messages, URLs, state, hashes, identifiers, `_meta`, client details, configuration, PII, and baggage.

The existing raw `onToolCall` callback is unchanged and is not certified privacy-safe by this contract.

Hosts control any local collection, configuration, privacy policy, access, retention, and loss handling. None is enabled here. Hosts must not interpret missing observations as proof that an action did not occur.

## Future extensions

These recipes add observation to existing features, not feature behavior. Neither producer extension is implemented here; either may land first and must retain the other's accepted members.

### Destructive SQL confirmation

#408 is already merged (`c9c4e3f`). `database-operation-tools.ts` already calls `inspectConfirmationState`; preserve its parser, policy, and execution behavior.

- Add `destructive_sql` to `ConfirmationFeature` and `not_destructive` to decision reasons.
- Widen both operation variants to permit `cost | destructive_sql`; retain `durationMs` on `returned | threw`.
- Reuse the `execute_sql` and `apply_migration` buckets; add no tool bucket, issuance mode, action, or end result.
- Retain every cost member, including `tool_mismatch` and `changed_quote`, and any accepted URL members. Never add `secret_collection` to operations.
- Malformed same-tool state remains generic `tool_error` only; do not add `invalid_state`.

| Decision pair | Branch |
| --- | --- |
| `inline/eligible` | Eligible inline confirmation |
| `bypass/not_configured` | Confirmation not configured |
| `bypass/capability_missing` | Required capability missing |
| `bypass/not_destructive` | Classifier reports not destructive |
| `bypass/read_only` | `execute_sql` only |
| `blocked/read_only` | `apply_migration` only |

`not_destructive` reports the classifier's result, not global SQL safety or authorization. Preserve initial no-state, missing-response, tool/argument-mismatch, and cost `changed_quote` distinctions.
If SQL adopts `checkConfirmationState`, keep it the sole owner of `input_response` and `resume_validation`; it also records `input_required` only after `askForConfirmation` resolves, when minting and response construction have succeeded. Time actual awaited `executeSql`/`applyMigration` calls, including bypass paths, not parsing or policy; emit no operations for decline, cancel, invalid, or missing-response paths.

### URL secret collection

#412 is already merged (`fb88629`). `secret-tools.ts` handles state inline; preserve its TTL, `issued_at`, fresh-call recovery, and gating without changing cost instrumentation.

- Add `secret_collection` to `ConfirmationFeature`, `create_edge_function_secret` to `ObservedTool`, and decision reasons `recent_update | unsupported_client`.
- Widen issuance modes to `form | url` and add issuance reason `update_not_observed`.
- Add `Readonly<{ kind: 'url_metadata'; observation: 'recent_update_observed' | 'resume_update_observed' | 'update_not_observed' }>` with no `feature` field.
- Retain cost and any accepted SQL members. Add neither secret operations nor `resume_validation.update_not_observed` nor a URL-only `invalid_state`.

| Branch | Observations |
| --- | --- |
| Read-only block | `blocked/read_only` |
| Initial unsupported client | `blocked/unsupported_client` |
| Initial recent update | `bypass/recent_update` and `recent_update_observed` |
| Normal initial issuance | `inline/eligible`, then successful `url/initial` issuance |
| Retry | `inline/eligible`, without an invented capability check |

Instrument the inline mismatch, missing-response, and action branches once. A validated accept emits `accept` and `valid` once, then `resume_update_observed` or `update_not_observed`; the latter reissues `url/update_not_observed` while preserving `issued_at`. Record issuance only after minting and response construction succeed.
Neither `getUpdatedAt` nor external dashboard writes are observed operations, and there is no modern completion-notification hook. URL facts do not prove consent, display, opening, completion, a causal write, uniqueness, or abandonment.

For either extension, update canonical types, public exports, recorder consumers, and exhaustive consumers, and deliberately select a compatible package version: finite-union additions can break exhaustive consumers. Exercise the packed ESM/CJS consumer fixtures against the immutable package artifact, retaining existing cost compatibility.
