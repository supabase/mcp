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

`input_required` records successful issuance only after minting and response construction succeed. It does not establish delivery or display. `input_response/accept` records an action, not independently verified consent.

Observation does not change confirmation rules or execution behavior.

## Failure isolation and disabled behavior

With no observer, there is no scope, context, fact, clock, or Promise work. Guards and forwarding of `undefined` remain. If a configured factory returns `undefined`, the initial timestamp and context have already been created, but no subsequent facts, timing, or recorder are created for that scope.

The safe wrapper catches factory failures, `record` and `end` property access or call failures, and rejection-attachment failures. It never awaits, retries, or logs sink failures. The internal helper ignores late facts and duplicate `end` calls; tools are not exposed to `end`. This is not an exactly-once delivery guarantee.

Rejection handling uses a private intrinsic `Promise.prototype.then.call(Promise.resolve(value), undefined, drop)`, bypassing an individual Promise's own `catch` or `then` overrides. This is failure isolation, not a sandbox: global Promise tampering and hostile constructor or species access are outside the guarantee. A blocking synchronous sink cannot be preempted.

## Privacy and host responsibilities

Observer DTOs contain finite literal values and numeric durations only. They exclude raw arguments, results, SQL, errors, messages, URLs, state, hashes, identifiers, `_meta`, client details, configuration, PII, and baggage.

The existing raw `onToolCall` callback is unchanged and is not certified privacy-safe by this contract.

Hosts control any local collection, configuration, privacy policy, access, retention, and loss handling. None is enabled here. Hosts must not interpret missing observations as proof that an action did not occur.

## Future extensions

The following recipes are separately authorized contract and integration changes, not implemented features, dormant runtime branches, or blockers for the current observer. Each recipe is independently applicable. Either may land first; the second must retain the first's accepted members.

### Release and adoption order

Apply this sequence independently for each extension, including when the other extension has already shipped:

1. Inspect and pin the actual accepted, merged feature implementation and its host integration. A proposal is not acceptance.
2. Agree on the exact canonical declarations. Obtain producer and host type acknowledgment and deliberately choose a compatible package version. Finite-union additions can break exhaustive consumers, so they are not automatically minor changes.
3. Publish an immutable package artifact and establish its integrity.
4. Adopt that release in the host with lockfile integrity. Acknowledge the actual imported types, mappings, configuration, closed allowlists, schemas, and fixtures against the published contract.

Do not substitute an unpublished source checkout, a proposed schema, or an assumed version for these steps.

### Destructive SQL confirmation

Before editing, inspect and pin the accepted, merged destructive-SQL implementation succeeding public MCP408 and its actual host integration. Preserve its parser, policy, and execution behavior.

#### Contract delta

- Add `'destructive_sql'` to `ConfirmationFeature`.
- Add `not_destructive` to decision reasons.
- Add `invalid_state` to resume-validation results only if the accepted implementation's combined `schema.safeParse` failure requires it. Otherwise, represent the actual branches deliberately rather than inventing a combined failure.
- Widen **both** operation variants to `feature: 'cost' | 'destructive_sql'`: the `started` variant and the `returned | threw` variant with `durationMs`.
- Reuse the existing `execute_sql` and `apply_migration` tool buckets. Add no tool bucket, issuance mode, action, or end result.
- Retain every cost member, including `tool_mismatch` and `changed_quote`, even if a migrated checker no longer emits some of them.
- If the URL extension has landed, retain its members. Do not add `'secret_collection'` to operations.

#### Branches and ownership

Emit these SQL decision pairs at the accepted branches:

| Pair | Scope |
| --- | --- |
| `inline/eligible` | Eligible inline confirmation |
| `bypass/not_configured` | Confirmation not configured |
| `bypass/capability_missing` | Required capability missing |
| `bypass/not_destructive` | Classifier reports not destructive |
| `bypass/read_only` | `execute_sql` only |
| `blocked/read_only` | `apply_migration` only |

`not_destructive` reports the classifier's result, not global SQL safety. Generic observation counts do not prove parsing correctness or authorization.

If the accepted implementation adopts shared `checkConfirmationState`, make that checker the sole owner of `input_response` and `resume_validation`. Remove duplicate inline account and branch records in the same change. Callers remain the sole owners of successful issuance and actual operation records.

Preserve the distinctions between initial requests with no state and no validation, missing responses, argument mismatches, cost payload mismatches reported as `changed_quote`, and any actual combined `invalid_state` branch. Do not collapse these while migrating cost callers.

Time the actual `executeSql` and `applyMigration` calls, including bypass paths. Do not time the parser or policy decision as an operation, and do not emit operations for decline, cancel, invalid, or missing-response paths.

#### Producer and host changes

Update canonical types, public exports, recorder consumers, and exhaustive fixtures. Update the host's actual imported types, closed allowlists, exhaustive switches, and sparse labels. Change the configuration snapshot only for the accepted implementation's actual per-tool option and skip branches. No new metric name is required.

Complete the release and adoption sequence above and the successor proofs below. This recipe does not depend on URL confirmation.

### URL secret collection

Before editing, inspect and pin the accepted, merged secret-collection implementation succeeding public MCP412 and its actual host integration. Preserve its TTL, `issued_at`, recovery behavior, and gating.

#### Contract delta

- Add `secret_collection` to `ConfirmationFeature`.
- Add `create_edge_function_secret` to `ObservedTool`.
- Add decision reasons `recent_update` and `unsupported_client`.
- Widen issuance modes to `form | url` and add issuance reason `update_not_observed`.
- Add exactly this fact, with **no `feature` field**:

    Readonly<{
      kind: 'url_metadata';
      observation:
        | 'recent_update_observed'
        | 'resume_update_observed'
        | 'update_not_observed';
    }>

- Never add `secret_collection` to either operation variant. Operations retain `cost`, or `cost | destructive_sql` if SQL has landed.
- Do not add `resume_validation.update_not_observed`. Do not add a URL-only `invalid_state` unless the accepted combined checker independently warrants that deliberate addition.
- Retain existing cost members and any accepted SQL members. Do not create a SQL dependency for this recipe.

#### Branches and ownership

Preserve these exact branches:

| Branch | Observations |
| --- | --- |
| Read-only block | `blocked/read_only` |
| Initial unsupported client | `blocked/unsupported_client` |
| Initial recent update | `bypass/recent_update` and `recent_update_observed` |
| Normal initial issuance | `inline/eligible`, then successful `url/initial` issuance |
| Retry | `inline/eligible`, without an invented capability check |

Use the accepted implementation's actual mismatch, missing-response, and action branches. A validated accept emits `accept` and `valid` once, then either `resume_update_observed` or `update_not_observed`. The latter reissues `url/update_not_observed` while preserving `issued_at`.

If a shared checker owns action and validation facts, remove duplicate caller records in the same change. Otherwise, leave cost instrumentation alone. Callers own successful issuance after minting and construction, not attempted issuance.

Neither `getUpdatedAt` nor external dashboard writes are observed operations. There is no modern completion-notification hook. URL facts do not prove consent, display, opening, completion, a causal write, uniqueness, or abandonment.

#### Producer and host changes

Update canonical types, public exports, recorder consumers, and exhaustive fixtures. Update the host's actual imported types, mappings, closed allowlists, exhaustive switches, schemas, and sparse-label fixtures while preserving accepted gating and configuration.

The future host integration adds `mcp_observer_url_metadata_total{observation}` with exactly three values: `recent_update_observed`, `resume_update_observed`, and `update_not_observed`. It has no tool, project, or URL labels. `create_edge_function_secret` becomes a named tool instead of `other`. Add no URL operation histogram. Update label fixtures and cardinality expectations.

Complete the release and adoption sequence above and the successor proofs below. This metric and host integration are not configured by the current package.

### Required successor proofs

For each extension, establish these proofs against the accepted implementation and the published producer/host contract:

- Every feature branch, plus every migrated cost branch, produces the intended facts without duplicate action or validation records.
- Mint failure emits no issuance fact. Operations cover actual protected calls, including bypass paths, and never decline, cancel, invalid, or missing-response paths. URL collection emits no operation facts.
- Business behavior remains unchanged. SDK pre-entry rejection remains outside observer scopes.
- Privacy sentinels remain excluded; unknown or impossible DTOs are rejected at the intended contract boundaries.
- Reverse-order concurrent completion, replay, and observation loss preserve attempt-local semantics without inventing correlation or delivery guarantees.
- Host labels remain sparse and bounded. Cardinality fixtures and duration conversion to seconds agree with actual mappings. Verify the approved seconds buckets `[0.05,0.1,0.25,0.5,1,2,5,10,20,30,60]`, plus `+Inf`, count, and sum. These are future host-integration proofs, not metric registration by this package.
- Public ESM and CJS consumption, exhaustive consumers, and old/new producer-host compatibility are exercised for the deliberately selected version. Adoption uses the immutable published artifact and matching lockfile integrity.

For SQL, cover classifier, `readOnly`, configuration, capability, and skip branches, plus the accepted combined validation branches. Prove that generic counts are not presented as parsing or authorization evidence.

For URL, cover supported and unsupported clients, hidden-but-callable behavior, mint failure, missing and non-elicitation responses, wrong-tool and argument mismatches, decline, cancel, TTL, `issued_at` preservation, gating, and the accepted fresh-call recovery behavior. Cover both metadata outcomes after validated accept and reissuance without inferring consent, display, opening, completion, causal writes, uniqueness, or abandonment.
