import type { ServerContext } from '@modelcontextprotocol/server';
import type { ConfirmationFeature, ObservationFact } from '../observation.js';
import { isSqlClassificationFailure } from '../sql-classification-failure.js';
import {
  SqlClassifierCallError,
  type SqlClassificationFailureKind,
  type SqlConfirmationClassifier,
  type SqlConfirmationReason,
} from '../sql-confirmation.js';

/**
 * Why SQL needs confirmation, as the classify step reports it. Adds
 * `oversized` to the classifier's reasons so SQL over the size cap gets its
 * own prompt.
 */
export type SqlClassifyReason = SqlConfirmationReason | 'oversized';

type SqlClassifierCallFact = Extract<
  ObservationFact,
  { kind: 'sql_classifier_call' }
>;

/**
 * Asks the server's classifier whether SQL needs confirmation. Every tool that
 * runs caller SQL behind a confirmation gets this same step.
 *
 * Resolves with the reason, or `undefined` when the SQL needs no confirmation.
 * Throws a `SqlClassifierCallError` when the classifier cannot answer, and the
 * request's abort reason when the request was cancelled. Either way the SQL
 * must not run.
 *
 * With `observation.record`, records one `sql_classifier_call` fact when the
 * classifier call settles, before the step returns or throws. `observation`
 * and its `record` are required, so no caller can leave the fact out by
 * accident. Pass `record: undefined` when the call has no observer.
 */
export type SqlClassifyStep = (
  sql: string,
  ctx: ServerContext,
  observation: Readonly<{
    feature: ConfirmationFeature;
    record: ((fact: SqlClassifierCallFact) => void) | undefined;
  }>
) => Promise<SqlClassifyReason | undefined>;

// Each reason the classifier can resolve with, and the fact `result` for it.
const SQL_CONFIRMATION_REASONS: Record<
  SqlConfirmationReason,
  SqlClassifierCallFact['result']
> = {
  destructive: 'destructive',
  'do-heuristic': 'do_heuristic',
  unclassified: 'unclassified',
};

// Over the size cap asks for confirmation; any other failure stops the call.
const SQL_CLASSIFICATION_FAILURE_OUTCOMES: Record<
  SqlClassificationFailureKind,
  'confirm' | 'error'
> = {
  oversized: 'confirm',
  unavailable: 'error',
  timeout: 'error',
  crashed: 'error',
};

function isKnownKey<T extends string>(
  record: Record<T, unknown>,
  value: unknown
): value is T {
  return typeof value === 'string' && Object.hasOwn(record, value);
}

// The failure kind of a result that is exactly a `SqlClassificationFailure`.
// Reading a result can throw (a getter or a Proxy trap). Such a result is
// outside the contract like any other, and what it threw is dropped.
function toSqlClassificationFailureKind(
  classification: unknown
): SqlClassificationFailureKind | undefined {
  try {
    if (!isSqlClassificationFailure(classification)) return undefined;
    // A live object can answer this read differently from the guard's reads,
    // so the value returned is the one checked here.
    const failure: unknown = classification.failure;
    return isKnownKey(SQL_CLASSIFICATION_FAILURE_OUTCOMES, failure)
      ? failure
      : undefined;
  } catch {
    return undefined;
  }
}

// What the classifier resolved with, after one checked read: `undefined`, a
// reason, a failure kind, or `invalid` for a result outside the contract.
type SqlClassifierOutcome =
  | SqlConfirmationReason
  | SqlClassificationFailureKind
  | 'invalid'
  | undefined;

// Checks a classifier result. The result can come from another process, so it
// is checked at runtime. The step derives this once and maps the fact and the
// reason or error from it, so the two always describe the same outcome.
function toSqlClassifierOutcome(classification: unknown): SqlClassifierOutcome {
  if (classification === undefined) return undefined;
  if (isKnownKey(SQL_CONFIRMATION_REASONS, classification)) {
    return classification;
  }
  return toSqlClassificationFailureKind(classification) ?? 'invalid';
}

// Maps the outcome to the confirmation reason: only `undefined` skips
// confirmation, and any result outside the contract stops the call, so SQL
// never runs unconfirmed.
function toSqlConfirmationReason(
  outcome: SqlClassifierOutcome
): SqlClassifyReason | undefined {
  if (outcome === undefined) return undefined;
  if (outcome === 'invalid') {
    throw new SqlClassifierCallError(
      'Could not check the SQL for destructive operations (classifier returned an invalid result).'
    );
  }
  if (isKnownKey(SQL_CONFIRMATION_REASONS, outcome)) return outcome;
  if (SQL_CLASSIFICATION_FAILURE_OUTCOMES[outcome] === 'confirm') {
    return 'oversized';
  }
  throw new SqlClassifierCallError(
    `Could not check the SQL for destructive operations (classifier ${outcome}).`
  );
}

// The fact `result` for the outcome. Only fixed values, so nothing from the
// classifier's own result reaches the fact.
function toSqlClassifierCallResult(
  outcome: SqlClassifierOutcome
): SqlClassifierCallFact['result'] {
  if (outcome === undefined) return 'not_destructive';
  if (isKnownKey(SQL_CONFIRMATION_REASONS, outcome)) {
    return SQL_CONFIRMATION_REASONS[outcome];
  }
  return outcome;
}

// Starts timing one classifier call. Call the returned function when the
// classifier settles to record the call's fact.
function startSqlClassifierCallFact(
  feature: ConfirmationFeature,
  record: (fact: SqlClassifierCallFact) => void
) {
  const startedAt = performance.now();
  return (result: SqlClassifierCallFact['result']) =>
    record({
      kind: 'sql_classifier_call',
      feature,
      result,
      durationMs: performance.now() - startedAt,
    });
}

/**
 * Builds the classify step around `classifier`. Build it once per server and
 * hand the same step to every tool that runs caller SQL.
 */
export function createSqlClassifyStep(
  classifier: SqlConfirmationClassifier
): SqlClassifyStep {
  return async (sql, ctx, observation) => {
    const { signal } = ctx.mcpReq;
    // No timing work without a `record`. A cancelled request records
    // `aborted`, whatever the classifier resolved or threw.
    const recordSettled = observation.record
      ? startSqlClassifierCallFact(observation.feature, observation.record)
      : undefined;
    let classification: unknown;
    try {
      classification = await classifier(sql, { signal });
    } catch {
      recordSettled?.(signal.aborted ? 'aborted' : 'rejected');
      // A cancelled request rethrows its abort, whatever the classifier threw.
      signal.throwIfAborted();
      // What the classifier threw is dropped, with no `cause`, so nothing of
      // it reaches the tool result or the host.
      throw new SqlClassifierCallError(
        'Could not check the SQL for destructive operations (classifier failed).'
      );
    }
    const outcome = toSqlClassifierOutcome(classification);
    recordSettled?.(
      signal.aborted ? 'aborted' : toSqlClassifierCallResult(outcome)
    );
    // A cancelled request must not go on to run the SQL.
    signal.throwIfAborted();
    return toSqlConfirmationReason(outcome);
  };
}
