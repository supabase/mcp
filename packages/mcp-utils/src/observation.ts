/** Observations describe handler attempts, not transport delivery or backend commit. */
export type ObservedMethod =
  | 'tools/call'
  | 'tools/list'
  | 'resources/list'
  | 'resources/templates/list'
  | 'resources/read';

export type ObservationContext<Bucket extends string = never> =
  | Readonly<{ method: 'tools/call'; tool: Bucket | 'other' }>
  | Readonly<{ method: Exclude<ObservedMethod, 'tools/call'> }>;

export type ToolOutcome = 'completed' | 'declined' | 'cancelled';

export type ToolObservation<Fact = never> = Readonly<{
  record: (fact: Fact) => void;
  setOutcome: (result: ToolOutcome) => void;
}>;

export type ObservationEnd = Readonly<{
  result: ToolOutcome | 'input_required' | 'tool_error' | 'handler_error';
  durationMs: number;
}>;

/** Sink failures are isolated; custom facts remain the producer's responsibility. */
export type RequestObservation<Fact = never> = Readonly<{
  record: (fact: Fact) => void | Promise<void>;
  end: (result: ObservationEnd) => void | Promise<void>;
}>;

/** Synchronous factory; promises and thenables are unsupported. */
export type RequestObserver<Bucket extends string = never, Fact = never> = (
  context: ObservationContext<Bucket>
) => RequestObservation<Fact> | undefined;

/** Package-internal lifecycle controls are never passed to a tool. */
export type ObservationScope<Fact = never> = Readonly<{
  tool: ToolObservation<Fact>;
  end: (result: ObservationEnd['result']) => void;
  outcome: () => ToolOutcome;
}>;

/**
 * Factory and sink failures are contained, never awaited or logged.
 * Synchronous callbacks can still block; this is not a CPU sandbox.
 */
export function beginObservation<Bucket extends string = never, Fact = never>(
  observer: RequestObserver<Bucket, Fact> | undefined,
  context: ObservationContext<Bucket>
): ObservationScope<Fact> | undefined {
  if (!observer) return undefined;
  const start = performance.now();
  let observation: RequestObservation<Fact> | undefined;
  try {
    observation = observer(context);
    if (
      observation &&
      'then' in observation &&
      typeof observation.then === 'function'
    ) {
      void Promise.resolve(observation).catch(() => {});
      return undefined;
    }
  } catch {
    return undefined;
  }
  if (!observation) return undefined;

  let ended = false;
  let outcome: ToolOutcome = 'completed';
  return {
    tool: {
      record(fact): void {
        if (!ended) safeCall(() => observation.record(fact));
      },
      setOutcome(result): void {
        if (!ended) outcome = result;
      },
    },
    end(result): void {
      if (ended) return;
      ended = true;
      const durationMs = performance.now() - start;
      safeCall(() => observation.end({ result, durationMs }));
    },
    outcome: () => outcome,
  };
}

function safeCall(action: () => void | Promise<void>): void {
  try {
    void Promise.resolve(action()).catch(() => {});
  } catch {
    // Telemetry-only failure: never surface, retry, or log the raw value.
  }
}
