import { z } from 'zod/v4';

/** The analytics endpoint can return a query error inside an HTTP 200 body. */
export function parseLogQueryRows(value: unknown): Record<string, unknown>[] {
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(value))
      return z.array(z.record(z.string(), z.unknown())).parse(value);
    if (value && typeof value === 'object') {
      if ('error' in value && value.error != null) {
        const error = value.error;
        throw new Error(
          typeof error === 'string'
            ? error
            : error &&
                typeof error === 'object' &&
                'message' in error &&
                typeof error.message === 'string'
              ? error.message
              : 'The logs query failed.'
        );
      }
      if ('result' in value) {
        value = value.result;
        continue;
      }
    }
    break;
  }
  throw new Error('The server returned an unsupported logs response.');
}
