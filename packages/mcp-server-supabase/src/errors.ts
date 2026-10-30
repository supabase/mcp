const toolCallerErrorBrand = Symbol.for('supabase.mcp.callerError');

/**
 * A tool error caused by the caller's input, comparable to an HTTP 4xx.
 */
export class ToolCallerError extends Error {
  declare [toolCallerErrorBrand]: true;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ToolCallerError';
    // Assigned here because a class field initializer miscompiles in the CJS build.
    this[toolCallerErrorBrand] = true;
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
