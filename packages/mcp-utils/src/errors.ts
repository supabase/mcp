const toolCallerErrorBrand = Symbol.for('supabase.mcp.callerError');

/**
 * What a caller error asks of the caller. `confirmation_required` means the
 * tool needs a confirmation step first (e.g. a matching `confirm_cost_id`).
 */
export type ToolCallerErrorKind = 'confirmation_required';

/**
 * A tool error caused by the caller's input, comparable to an HTTP 4xx.
 */
export class ToolCallerError extends Error {
  declare [toolCallerErrorBrand]: true;
  declare readonly kind?: ToolCallerErrorKind;

  constructor(
    message: string,
    options?: ErrorOptions & { kind?: ToolCallerErrorKind }
  ) {
    super(message, options);
    this.name = 'ToolCallerError';
    // Assigned here because a class field initializer miscompiles in the CJS build.
    this[toolCallerErrorBrand] = true;
    if (options?.kind !== undefined) {
      this.kind = options.kind;
    }
  }
}

/**
 * Checks the global symbol brand so errors from another installed copy of this package still match.
 */
export function isToolCallerError(error: unknown): error is ToolCallerError {
  return (
    typeof error === 'object' &&
    error !== null &&
    toolCallerErrorBrand in error &&
    error[toolCallerErrorBrand] === true
  );
}
