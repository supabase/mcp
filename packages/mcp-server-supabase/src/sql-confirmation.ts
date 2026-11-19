/**
 * SQL confirmation classifier contract, importable on its own (for example
 * from a worker process) without constructing an MCP server.
 */

import { isSqlClassificationFailure } from './sql-classification-failure.js';
import { isDestructiveSql } from './tools/destructive-sql.js';

/**
 * Why SQL needs confirmation. In `execute_sql` and `apply_migration` each
 * reason gets its own prompt. `run_notebook` shows one prompt for the whole
 * notebook, with the same wording for every reason.
 *
 * - `destructive`: the SQL contains DROP, DELETE, TRUNCATE or UPDATE without
 *   WHERE.
 * - `do-heuristic`: a DO block whose body suggests destructive operations.
 * - `unclassified`: the classifier could not classify the SQL syntax.
 */
export type SqlConfirmationReason =
  | 'destructive'
  | 'do-heuristic'
  | 'unclassified';

/**
 * Why a classifier could not classify the SQL.
 *
 * - `oversized`: the SQL is over the classifier's size cap. The tool asks for
 *   confirmation. `execute_sql` and `apply_migration` say the SQL was too
 *   large to check.
 * - `unavailable`, `timeout`, `crashed`: the classifier could not answer.
 *   The tool call fails with an error and the SQL does not run. `unavailable`
 *   covers both a classifier that cannot load and a pool that sheds the
 *   request, so `withFallback` falls back on both.
 */
export type SqlClassificationFailureKind =
  | 'oversized'
  | 'unavailable'
  | 'timeout'
  | 'crashed';

export type SqlClassificationFailure = {
  failure: SqlClassificationFailureKind;
};

/**
 * `undefined` means the SQL needs no confirmation.
 */
export type SqlConfirmationClassification =
  | SqlConfirmationReason
  | SqlClassificationFailure
  | undefined;

/**
 * Classifies SQL for `execute_sql` and `apply_migration` confirmation.
 *
 * It also decides whether a `run_notebook` run asks for confirmation: the
 * tool calls it on the database cells in order and stops at the first one it
 * flags. It does not pick the mode a cell runs in.
 *
 * Resolve with:
 * - `undefined`: the SQL runs without confirmation. This is the only result
 *   that skips confirmation.
 * - a `SqlConfirmationReason`: the tool asks for confirmation. `execute_sql`
 *   and `apply_migration` use the prompt for that reason.
 * - a `SqlClassificationFailure`: `oversized` asks for confirmation;
 *   `unavailable`, `timeout` and `crashed` fail the tool call and the SQL does
 *   not run.
 *
 * The tool checks the result at runtime. Any other value (for example `null`,
 * `false`, an unknown string or an unknown failure kind) fails the tool call
 * like `crashed`. A rejection or throw also fails the tool call, and the SQL
 * does not run. Each of these failures reaches the client and the host as a
 * `SqlClassifierCallError`.
 *
 * `signal` aborts when the MCP request is cancelled. Pass it on to the work
 * (for example a worker call) so it stops early, and settle promptly once it
 * aborts.
 */
export interface SqlConfirmationClassifier {
  (
    sql: string,
    options: { signal: AbortSignal }
  ): Promise<SqlConfirmationClassification>;
}

/**
 * Throw this from a classifier that cannot load or run (for example a parser
 * whose WASM module failed to load), so `withFallback` uses its fallback.
 * Without `withFallback` it fails the tool call like any other rejection.
 *
 * `withFallback` matches it by `name`, so it does not survive structured
 * cloning or IPC. A classifier in another process should resolve with
 * `{ failure: 'unavailable' }` instead.
 */
export class SqlClassifierUnavailableError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SqlClassifierUnavailableError';
  }
}

/**
 * The error a tool call fails with when the classifier could not answer: it
 * resolved with `unavailable`, `timeout` or `crashed`, resolved with a result
 * outside the contract, or rejected. The SQL does not run.
 *
 * The message comes from a fixed set and never includes the classifier's own
 * error name or message.
 *
 * Match it by `name`: the ESM and CJS builds of this module each have their
 * own class, so `instanceof` can miss.
 */
export class SqlClassifierCallError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SqlClassifierCallError';
  }
}

/**
 * The regex classifier: `destructive` when the SQL matches the destructive
 * SQL patterns, otherwise `undefined`. This is the default classifier.
 */
export const regexClassifier: SqlConfirmationClassifier = async (sql) =>
  isDestructiveSql(sql) ? 'destructive' : undefined;

/**
 * Uses `fallback` when `primary` cannot answer: when `primary` resolves with a
 * failure whose kind is in `on` (default `['unavailable']`), or rejects with a
 * `SqlClassifierUnavailableError`. Any other result passes through unchanged,
 * including other failure kinds and an object that is not exactly a
 * `SqlClassificationFailure`, which the tool then fails as an invalid result.
 * Any other rejection propagates. Both receive the same `signal`.
 *
 * The fallback's result is final, so a fallback failure still fails closed.
 *
 * `unavailable` also covers a worker pool that sheds load, so a pool wrapped
 * here answers with the fallback under load instead of failing the call.
 * Adding `timeout` or `crashed` to `on` goes further: those fail the call by
 * default, and with them in `on` the fallback answers instead.
 */
export function withFallback(
  primary: SqlConfirmationClassifier,
  fallback: SqlConfirmationClassifier,
  {
    on = ['unavailable'],
  }: { on?: readonly SqlClassificationFailureKind[] } = {}
): SqlConfirmationClassifier {
  return async (sql, options) => {
    let classification: SqlConfirmationClassification;
    try {
      classification = await primary(sql, options);
    } catch (error) {
      // Matched by name, so the error still matches when the ESM and CJS
      // builds of this module are both loaded.
      if (
        !(error instanceof Error) ||
        error.name !== 'SqlClassifierUnavailableError'
      ) {
        throw error;
      }
      return await fallback(sql, options);
    }
    let failure: SqlClassificationFailureKind | undefined;
    try {
      failure = isSqlClassificationFailure(classification)
        ? classification.failure
        : undefined;
    } catch {
      // Reading the result threw. That is not a rejection of `primary`, so the
      // result passes through for the tool to fail as an invalid result.
      return classification;
    }
    if (failure !== undefined && on.includes(failure)) {
      return await fallback(sql, options);
    }
    return classification;
  };
}
