/**
 * Internal to this package: not a build entry and not part of the public
 * `./sql-confirmation` surface.
 */

import type {
  SqlClassificationFailure,
  SqlClassificationFailureKind,
} from './sql-confirmation.js';

const SQL_CLASSIFICATION_FAILURE_KINDS: Record<
  SqlClassificationFailureKind,
  true
> = {
  oversized: true,
  unavailable: true,
  timeout: true,
  crashed: true,
};

/**
 * Whether `value` is exactly a `SqlClassificationFailure`: a plain object
 * whose only own key is `failure`, with a known kind.
 */
export function isSqlClassificationFailure(
  value: unknown
): value is SqlClassificationFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'failure') &&
    'failure' in value &&
    typeof value.failure === 'string' &&
    Object.hasOwn(SQL_CLASSIFICATION_FAILURE_KINDS, value.failure)
  );
}
