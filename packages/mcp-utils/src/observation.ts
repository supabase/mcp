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

export type ToolClassification<Bucket extends string> = Readonly<{
  buckets: readonly Bucket[];
  classify: (name: string) => NoInfer<Bucket> | 'other';
}>;

/** Package-internal lifecycle controls are never passed to a tool. */
export type ObservationScope<Fact = never> = Readonly<{
  tool: ToolObservation<Fact>;
  end: (result: ObservationEnd['result']) => void;
  outcome: () => ToolOutcome;
}>;

/** Snapshot configuration only when the caller has enabled observation. */
export function snapshotToolClassification<Bucket extends string>(
  configuration: ToolClassification<Bucket> | undefined
): ((name: string) => Bucket | 'other') | undefined {
  try {
    if (!configuration) return undefined;
    const { buckets, classify } = configuration;
    if (!Array.isArray(buckets)) {
      return undefined;
    }
    const allowed = new Set<string>();
    for (const bucket of buckets) {
      if (typeof bucket !== 'string') return undefined;
      allowed.add(bucket);
    }
    return (name) => {
      try {
        const bucket = classify(name);
        if (typeof bucket === 'string') {
          return bucket === 'other' || allowed.has(bucket) ? bucket : 'other';
        }
        consumeAsync(bucket);
      } catch {
        // Classification cannot change handler behavior or expose raw names.
      }
      return 'other';
    };
  } catch {
    return undefined;
  }
}

/**
 * Factory and sink failures are contained, never awaited or logged.
 * Synchronous callbacks can still block; this is not a CPU sandbox.
 */
export function beginObservation<Bucket extends string = never, Fact = never>(
  observer: RequestObserver<Bucket, Fact> | undefined,
  context: ObservationContext<Bucket>,
  startedAt?: number
): ObservationScope<Fact> | undefined {
  if (!observer) return undefined;
  const start = startedAt ?? performance.now();
  let observation: RequestObservation<Fact> | undefined;
  try {
    observation = observer(context);
    if (consumeAsync(observation)) return undefined;
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
        if (
          !ended &&
          (result === 'completed' ||
            result === 'declined' ||
            result === 'cancelled')
        ) {
          outcome = result;
        }
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
    consumeAsync(action());
  } catch {
    // Telemetry-only failure: never surface, retry, or log the raw value.
  }
}

/** May throw during inspection or assimilation; callers isolate those failures. */
function consumeAsync(value: unknown): boolean {
  if (value instanceof Promise) {
    // Bypass native promises' hostile own then/catch getters.
    Promise.prototype.then.call(value, undefined, drop);
    return true;
  }
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  ) {
    Promise.prototype.then.call(Promise.resolve(value), undefined, drop);
    return true;
  }
  return false;
}

function drop(): void {}
