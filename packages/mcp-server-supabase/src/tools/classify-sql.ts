import type { ServerContext } from '@modelcontextprotocol/server';
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

/**
 * Asks the server's classifier whether SQL needs confirmation. Every tool that
 * runs caller SQL behind a confirmation gets this same step.
 *
 * Resolves with the reason, or `undefined` when the SQL needs no confirmation.
 * Throws a `SqlClassifierCallError` when the classifier cannot answer, and the
 * request's abort reason when the request was cancelled. Either way the SQL
 * must not run.
 */
export type SqlClassifyStep = (
  sql: string,
  ctx: ServerContext
) => Promise<SqlClassifyReason | undefined>;

const SQL_CONFIRMATION_REASONS: Record<SqlConfirmationReason, true> = {
  destructive: true,
  'do-heuristic': true,
  unclassified: true,
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

// Maps a classifier result to the confirmation reason. The result can come
// from another process, so it is checked at runtime: only `undefined` skips
// confirmation, and any result outside the contract stops the call, so SQL
// never runs unconfirmed.
function toSqlConfirmationReason(
  classification: unknown
): SqlClassifyReason | undefined {
  if (classification === undefined) return undefined;
  if (isKnownKey(SQL_CONFIRMATION_REASONS, classification)) {
    return classification;
  }
  const failure = toSqlClassificationFailureKind(classification);
  if (failure !== undefined) {
    if (SQL_CLASSIFICATION_FAILURE_OUTCOMES[failure] === 'confirm') {
      return 'oversized';
    }
    throw new SqlClassifierCallError(
      `Could not check the SQL for destructive operations (classifier ${failure}).`
    );
  }
  throw new SqlClassifierCallError(
    'Could not check the SQL for destructive operations (classifier returned an invalid result).'
  );
}

/**
 * Builds the classify step around `classifier`. Build it once per server and
 * hand the same step to every tool that runs caller SQL.
 */
export function createSqlClassifyStep(
  classifier: SqlConfirmationClassifier
): SqlClassifyStep {
  return async (sql, ctx) => {
    const { signal } = ctx.mcpReq;
    let classification: unknown;
    try {
      classification = await classifier(sql, { signal });
    } catch {
      // A cancelled request rethrows its abort, whatever the classifier threw.
      signal.throwIfAborted();
      // What the classifier threw is dropped, with no `cause`, so nothing of
      // it reaches the tool result or the host.
      throw new SqlClassifierCallError(
        'Could not check the SQL for destructive operations (classifier failed).'
      );
    }
    // A cancelled request must not go on to run the SQL.
    signal.throwIfAborted();
    return toSqlConfirmationReason(classification);
  };
}
