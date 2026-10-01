/**
 * SQL confirmation classifier contract, importable on its own (for example
 * from a worker process) without constructing an MCP server.
 */

import { isDestructiveSql } from './tools/destructive-sql.js';

/**
 * Why SQL needs confirmation. Each reason gets its own prompt.
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
 *   confirmation and says the SQL was too large to check.
 * - `unavailable`, `timeout`, `crashed`: the classifier could not answer.
 *   The tool call fails with an error and the SQL does not run.
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
 * Resolve with:
 * - `undefined`: the SQL runs without confirmation. This is the only result
 *   that skips confirmation.
 * - a `SqlConfirmationReason`: the tool asks for confirmation with the prompt
 *   for that reason.
 * - a `SqlClassificationFailure`: `oversized` asks for confirmation;
 *   `unavailable`, `timeout` and `crashed` fail the tool call and the SQL does
 *   not run.
 *
 * The tool checks the result at runtime. Any other value (for example `null`,
 * `false`, an unknown string or an unknown failure kind) fails the tool call
 * like `crashed`. A rejection or throw also fails the tool call, and the SQL
 * does not run.
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
 */
export class SqlClassifierUnavailableError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SqlClassifierUnavailableError';
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
 * `SqlClassifierUnavailableError`. Any other result, including other failure
 * kinds, passes through, and any other rejection propagates. Both receive the
 * same `signal`.
 *
 * The fallback's result is final, so a fallback failure still fails closed.
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
    if (
      typeof classification === 'object' &&
      classification !== null &&
      on.includes(classification.failure)
    ) {
      return await fallback(sql, options);
    }
    return classification;
  };
}
