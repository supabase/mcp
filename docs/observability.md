# Observability

The server provides an optional, vendor-neutral observer for five request-handler lifecycles and bounded facts recorded by tools, without exposing request contents. No collection, host metrics, provider, exporter, queue, or host adoption is configured by this API.

## API and ownership

Set `observer?: RequestObserver` on `McpServerOptions` for `createMcpServer`.

`@supabase/mcp-utils` exports:

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

Only the handler owns `end`. Tool code receives an optional safe, synchronous recorder through the additive third argument to `Tool.execute(params, context, record?: (fact: ObservationFact) => void)`. Existing one- and two-argument callers continue to work.

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

Currently, `execute_sql` and `apply_migration` are general handler buckets only. They emit no confirmation or operation facts; host `effective_config` remains `not_applicable` until the corresponding extension is adopted.

For `tools/call`, observation begins before tool lookup, name validation, and Zod validation. Each scope ends in `finally`, after response shaping and before transport. End results use this precedence:

1. `handler_error`: an error escapes the handler.
2. `tool_error`: the direct result has `isError: true`.
3. `input_required`: the response requests input.
4. `declined` or `cancelled`: a terminal decline or cancel was consumed.
5. `completed`: none of the above applies.

The existing `resources/read` catch returns `isError: true`, so that path ends as `tool_error`. An escaping serialization error ends as `handler_error`.

Each retry or replay is a new attempt. There is no deduplication, flow identifier, cross-request state, abandonment timer, or abort-derived end result. `completed` describes handler completion, not completion of a multi-request confirmation flow.

### Durations

Handler `durationMs` uses a monotonic clock from handler entry through response shaping. It excludes SDK pre-entry validation, human wait between attempts, and transport. Timestamps are taken before the corresponding sink work.

Operation durations cover actual awaited protected calls, not the whole confirmation flow. `returned` does not prove readiness or commit; `threw` does not prove that nothing committed.

## Tool-recorded facts: cost confirmation

`ConfirmationFeature` contains only `cost`, and every fact has `feature: 'cost'`. Custom tools can record the full cost fact vocabulary; built-in Supabase cost instrumentation is not available.

| `kind` | Fields and values |
| --- | --- |
| `confirmation_decision` | `route: inline \| legacy \| bypass \| blocked`; `reason: eligible \| not_configured \| capability_missing \| read_only \| zero_cost` |
| `input_required` | `mode: form`; `reason: initial \| missing_response \| changed_quote` |
| `input_response` | `action: accept \| decline \| cancel` |
| `resume_validation` | `result: valid \| missing_response \| tool_mismatch \| arguments_mismatch \| changed_quote` |
| `operation` | `disposition: started` |
| `operation` | `disposition: returned \| threw`; `durationMs: number` |
## Failure isolation and disabled behavior

With no observer, there is no scope, context, fact, clock, or Promise work. Guards and forwarding of `undefined` remain. If a configured factory returns `undefined`, the initial timestamp and context have already been created, but no subsequent facts, timing, or recorder are created for that scope.

The safe wrapper catches factory failures, `record` and `end` property access or call failures, and rejection-attachment failures. It never awaits, retries, or logs sink failures. The internal helper ignores late facts and duplicate `end` calls; tools are not exposed to `end`. This is not an exactly-once delivery guarantee.

Rejection handling uses a private intrinsic `Promise.prototype.then.call(Promise.resolve(value), undefined, drop)`, bypassing an individual Promise's own `catch` or `then` overrides. This is failure isolation, not a sandbox: global Promise tampering and hostile constructor or species access are outside the guarantee. A blocking synchronous sink cannot be preempted.

## Privacy and host responsibilities

Observer DTOs contain finite literal values and numeric durations only. They exclude raw arguments, results, SQL, errors, messages, URLs, state, hashes, identifiers, `_meta`, client details, configuration, PII, and baggage.

The existing raw `onToolCall` callback is unchanged and is not certified privacy-safe by this contract.

Hosts control any local collection, configuration, privacy policy, access, retention, and loss handling. None is enabled here. Hosts must not interpret missing observations as proof that an action did not occur.

