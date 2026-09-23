/**
 * Payload-free observations for MCP handler attempts and shipped cost confirmation.
 * These types do not describe transport delivery, consent, or backend commit.
 * The Supabase server's vocabulary is intentionally hosted in mcp-utils.
 */

export type ObservedMethod =
  | 'tools/call'
  | 'tools/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read';

export type ObservedTool =
  | 'create_project'
  | 'create_branch'
  | 'execute_sql'
  | 'apply_migration'
  | 'other'
  | 'not_applicable';

export type ObservationContext = Readonly<{
  method: ObservedMethod;
  tool: ObservedTool;
}>;

export type ConfirmationFeature = 'cost';

export type ObservationFact =
  | Readonly<{
      kind: 'confirmation_decision';
      feature: ConfirmationFeature;
      route: 'inline' | 'legacy' | 'bypass' | 'blocked';
      reason:
        | 'eligible'
        | 'not_configured'
        | 'capability_missing'
        | 'read_only'
        | 'zero_cost';
    }>
  | Readonly<{
      kind: 'input_required';
      feature: ConfirmationFeature;
      mode: 'form';
      reason: 'initial' | 'missing_response' | 'changed_quote';
    }>
  | Readonly<{
      kind: 'input_response';
      feature: ConfirmationFeature;
      action: 'accept' | 'decline' | 'cancel';
    }>
  | Readonly<{
      kind: 'resume_validation';
      feature: ConfirmationFeature;
      result:
        | 'valid'
        | 'missing_response'
        | 'tool_mismatch'
        | 'arguments_mismatch'
        | 'changed_quote';
    }>
  | Readonly<{
      kind: 'operation';
      feature: ConfirmationFeature;
      disposition: 'started';
    }>
  | Readonly<{
      kind: 'operation';
      feature: ConfirmationFeature;
      disposition: 'returned' | 'threw';
      durationMs: number;
    }>;

export type ObservationEnd = Readonly<{
  result:
    | 'completed'
    | 'input_required'
    | 'declined'
    | 'cancelled'
    | 'tool_error'
    | 'handler_error';
  durationMs: number;
}>;

/** Host callbacks receive payload-free facts and one terminal result; failures are isolated. */
export type RequestObservation = Readonly<{
  record(fact: ObservationFact): void | Promise<void>;
  end(result: ObservationEnd): void | Promise<void>;
}>;

/** Synchronous factory for a handler observation; must not return a Promise or thenable. */
export type RequestObserver = (
  context: ObservationContext
) => RequestObservation | undefined;

type ConsumedTerminal = 'declined' | 'cancelled' | undefined;

/**
 * Package-internal handle wrapping a host-supplied {@link RequestObservation}
 * with failure isolation. Not part of the public contract: hosts never see
 * this type, only the plain `record`/`end` shape they implement.
 */
export type ObservationScope = Readonly<{
  record(fact: ObservationFact): void;
  end(result: ObservationEnd['result']): void;
  /**
   * Reads the terminal disposition implied by the last consumed
   * decline/cancel action, for handlers that otherwise return an ordinary
   * result. Callers must apply error precedence themselves: this is only
   * consulted on an otherwise-ordinary return, never after a thrown or
   * `isError` result.
   */
  consumedTerminal(): ConsumedTerminal;
}>;

/**
 * Begins an observation scope for one handler entry.
 *
 * Factory and sink failures are contained and never awaited or logged.
 * Unsupported asynchronous factories are discarded, consuming their rejection.
 * Synchronous callbacks can still block; this is not a CPU sandbox.
 */
export function beginObservation(
  observer: RequestObserver | undefined,
  context: ObservationContext
): ObservationScope | undefined {
  if (!observer) {
    return undefined;
  }

  const startedAt = performance.now();
  let observation: RequestObservation | undefined;

  try {
    observation = observer(context);

    if (observation instanceof Promise || isThenable(observation)) {
      // A synchronous factory returning a runtime Promise is unsupported.
      // Never await it; just consume any rejection and discard the scope.
      Promise.prototype.then.call(
        Promise.resolve(observation),
        undefined,
        drop
      );
      return undefined;
    }
  } catch {
    // Factory failure disables this scope; it must never affect the caller.
    return undefined;
  }

  if (!observation) {
    return undefined;
  }

  let ended = false;
  let consumedTerminal: ConsumedTerminal;

  return {
    record(fact: ObservationFact): void {
      // Reject late facts: once ended, this scope is inert.
      if (ended) {
        return;
      }

      if (fact.kind === 'input_response') {
        consumedTerminal =
          fact.action === 'decline'
            ? 'declined'
            : fact.action === 'cancel'
              ? 'cancelled'
              : undefined;
      }

      safeCall(() => observation!.record(fact));
    },
    end(result: ObservationEnd['result']): void {
      // First end wins; duplicate end is a silent no-op, not a failure.
      if (ended) {
        return;
      }
      ended = true;

      const durationMs = performance.now() - startedAt;
      safeCall(() => observation!.end({ result, durationMs }));
    },
    consumedTerminal(): ConsumedTerminal {
      return consumedTerminal;
    },
  };
}

/**
 * Calls `action`, swallowing any synchronous throw (including a throwing
 * property getter reached while evaluating `action`) and consuming any
 * rejection from a returned thenable without ever awaiting it.
 */
function safeCall(action: () => void | Promise<void>): void {
  try {
    const result = action();

    if (result !== undefined) {
      // Bypass sink-owned catch/then overrides on native promises.
      Promise.prototype.then.call(Promise.resolve(result), undefined, drop);
    }
  } catch {
    // Telemetry-only failure: never surface, retry, or log the raw value.
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }

  return 'then' in value && typeof value.then === 'function';
}

function drop(): void {}
