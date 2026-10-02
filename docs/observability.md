# Observability

The server provides an optional, vendor-neutral observer for five request-handler lifecycles, cost confirmation, and destructive-SQL confirmation. It emits bounded facts without exposing request contents. No collection, host metrics, provider, exporter, queue, or host adoption is configured by this API.

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

### Usage example

This example uses the console as a local sink; the host can choose a bounded metrics collector instead.

```typescript
import {
  createMcpServer,
  type RequestObserver,
} from '@supabase/mcp-utils';

const observer: RequestObserver = ({ method, tool }) => {
  return {
    record({ kind, feature }) {
      console.info({ method, tool, kind, feature });
    },
    end({ result, durationMs }) {
      console.info({ method, tool, result, durationMs });
    },
  };
};

const server = createMcpServer({
  name: 'example',
  version: '1.0.0',
  tools: {},
  observer,
});
```

Omit `observer` when collection is disabled; the package calls `end` for you.

## Request scope

| `ObservedMethod` | Tool classification |
| --- | --- |
| `tools/call` | `create_project`, `create_branch`, `execute_sql`, `apply_migration`, or `other` |
| `tools/list` | `not_applicable` |
| `resources/list` | `not_applicable` |
| `resources/templates/list` | `not_applicable` |
| `resources/read` | `not_applicable` |

Unknown tool names become `other`; raw names are not emitted. Initialize requests, notifications, unknown methods, and SDK rejections before handler entry do not create scopes.

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

## Current facts: confirmation

`ConfirmationFeature` contains `cost | destructive_sql`. Every current fact has one of these feature values. Both operation variants permit `cost | destructive_sql`; terminal operation facts require `durationMs`.

| `kind` | Fields and values |
| --- | --- |
| `confirmation_decision` | `route: inline \| legacy \| bypass \| blocked`; `reason: eligible \| not_configured \| capability_missing \| read_only \| zero_cost \| not_destructive` |
| `input_required` | `mode: form`; `reason: initial \| missing_response \| changed_quote` |
| `input_response` | `action: accept \| decline \| cancel` |
| `resume_validation` | `result: valid \| missing_response \| tool_mismatch \| arguments_mismatch \| changed_quote` |
| `operation` | `disposition: started` |
| `operation` | `disposition: returned \| threw`; `durationMs: number` |

### Cost confirmation

The cost decision pairs are:

- `blocked/read_only`.
- `legacy/not_configured`, checked before `legacy/capability_missing`.
- `inline/eligible`.
- Initial project-only `bypass/zero_cost`. Branch creation has no corresponding shortcut.

Modern resume validation, missing responses, changed quotes, and actions use the literal facts above. Legacy hash checks are not reported as modern resume validation.

All five actual protected project and branch call sites emit `operation/started`, followed by `operation/returned` or `operation/threw` with a duration. This includes legacy and zero-cost paths.

`checkConfirmationState` records `input_required` after the caller's `askForConfirmation` resolves, so issuance is recorded only when minting and response construction succeed. It does not establish delivery or display. `input_response/accept` records an action, not independently verified consent.

Observation does not change confirmation rules or execution behavior.

### Destructive SQL confirmation

`execute_sql` and `apply_migration` emit confirmation and operation facts using the shared vocabulary above. Their existing gates, state handling, classifier policy, and execution behavior are unchanged.

| Decision pair | Branch |
| --- | --- |
| `inline/eligible` | Eligible inline confirmation |
| `bypass/not_configured` | Confirmation not configured for the tool |
| `bypass/capability_missing` | Required capability missing |
| `bypass/not_destructive` | Classifier reports not destructive |
| `bypass/read_only` | `execute_sql` only |
| `blocked/read_only` | `apply_migration` only |

`not_destructive` reports the classifier's result, not global SQL safety or authorization. `not_configured` reports effective tool configuration; it does not identify a hosted flag value.

SQL inspects confirmation state before classification. Valid accepted resumes skip the classifier. For other state outcomes, the current classifier decides whether the state result is honored. Response and validation facts are emitted only for honored state decisions. An ignored decline or cancel on a `not_destructive` path therefore does not produce a false terminal decline or cancel. Classification failure emits no decision fact because the route remains undetermined.

`inspectConfirmationState` owns SQL response and validation facts. Request-local staging defers these facts until the state decision is honored and exists only when a recorder is present. There is no queue or cross-request correlation.

The SQL caller records `input_required` only after `askForConfirmation` resolves successfully, when minting and response construction have succeeded. Cost issuance remains owned by `checkConfirmationState`; neither flow duplicates facts. Issuance does not establish delivery or display, and an accepted action does not independently prove consent.

Initial requests, missing responses, and tool or argument mismatches retain their existing distinctions. Malformed same-tool state has no invented `invalid_state` fact: where existing SQL policy rejects it, the scope ends with generic `tool_error`.

Actual awaited `executeSql` and `applyMigration` calls emit `operation/started`, followed by `operation/returned` or `operation/threw` with a duration, including bypass paths. Parsing and policy checks are excluded. Honored decline, cancel, rejected-state, and missing-response paths emit no operation facts. `returned` does not prove readiness or commit; `threw` does not prove that nothing committed.

### Observation gaps

The API does not report:

- A `requestState` expiry or rejection subreason when the SDK rejects the request before the observer starts.
- Abandonment: attempts are stateless and have no cross-request correlation.
- Which classifier rule matched.
- Per-outcome capability context beyond the `capability_missing` gate.
- Hosted flag or cohort values. Effective package configuration does not identify the host flag.

No hosted consumption or Platform adoption is implemented here.

### Compatibility

Existing cost members, including `tool_mismatch` and `changed_quote`, and public re-export identity are retained. Finite-union additions can still break exhaustive TypeScript consumers. Release these additions in the next 0.x minor through normal release-please automation, with no patch-compatibility promise or manual package version changes.

## Failure isolation and disabled behavior

- With no observer, there is no observation work: no scope, context, fact, clock, or Promise work.
- The factory is called synchronously once per handler entry. A Promise or thenable it returns is discarded; `record` and `end` results are never awaited. Throws, throwing getters, and rejections from the factory, `record`, or `end` are swallowed without logging or retry, including when a returned Promise's own `then` or `catch` is overridden or throws. Facts after `end` and duplicate `end` calls are ignored; delivery is not exactly-once.
- This is isolation, not a sandbox: a blocking synchronous sink still blocks, and global Promise tampering and hostile constructor or species access are outside the guarantee.

## Privacy and host responsibilities

Observer DTOs contain finite literal values and numeric durations only. They exclude raw arguments, results, SQL, errors, messages, URLs, state, hashes, identifiers, `_meta`, client details, configuration, PII, and baggage.

The existing raw `onToolCall` callback is unchanged and is not certified privacy-safe by this contract.

Hosts control any local collection, configuration, privacy policy, access, retention, and loss handling. None is enabled here. Hosts must not interpret missing observations as proof that an action did not occur.

## Future extensions

The URL recipe below would add observation to an existing feature without changing its behavior. URL observation is not implemented here.

### URL secret collection

#412 is already merged (`fb88629`). `secret-tools.ts` handles state inline; preserve its TTL, `issued_at`, fresh-call recovery, and gating without changing cost or SQL instrumentation.

- Add `secret_collection` to `ConfirmationFeature`, `create_edge_function_secret` to `ObservedTool`, and decision reasons `recent_update | unsupported_client`.
- Widen issuance modes to `form | url` and add issuance reason `update_not_observed`.
- Add `Readonly<{ kind: 'url_metadata'; observation: 'recent_update_observed' | 'resume_update_observed' | 'update_not_observed' }>` with no `feature` field.
- Retain all current cost and SQL members. Keep operation features limited to `cost | destructive_sql`; add neither secret operations nor `resume_validation.update_not_observed` nor a URL-only `invalid_state`.

| Branch | Observations |
| --- | --- |
| Read-only block | `blocked/read_only` |
| Initial unsupported client | `blocked/unsupported_client` |
| Initial recent update | `bypass/recent_update` and `recent_update_observed` |
| Normal initial issuance | `inline/eligible`, then successful `url/initial` issuance |
| Retry | `inline/eligible`, without an invented capability check |

Instrument the inline mismatch, missing-response, and action branches once. A validated accept emits `accept` and `valid` once, then `resume_update_observed` or `update_not_observed`; the latter reissues `url/update_not_observed` while preserving `issued_at`. Record issuance only after minting and response construction succeed.
Neither `getUpdatedAt` nor external dashboard writes are observed operations, and there is no modern completion-notification hook. URL facts do not prove consent, display, opening, completion, a causal write, uniqueness, or abandonment.

For this extension, update canonical types, public exports, recorder consumers, and exhaustive consumers. Finite-union additions can break exhaustive TypeScript consumers, so use the next 0.x minor through normal release-please automation rather than promising patch compatibility. Exercise the packed ESM/CJS consumer fixtures against the immutable package artifact, retaining existing cost and SQL compatibility.
