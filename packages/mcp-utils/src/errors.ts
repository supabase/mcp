const toolCallerErrorBrand = Symbol.for('supabase.mcp.callerError');

/**
 * What a caller error asks of the caller. `confirmation_required` means the
 * tool needs a confirmation step first: a mismatched `confirm_cost_id`, or a
 * missing one when inline cost confirmation is configured. Without it, the
 * schema check rejects a missing `confirm_cost_id` first, and the error has a
 * `ZodError` cause and no kind.
 */
export type ToolCallerErrorKind = 'confirmation_required';

/**
 * A tool error caused by the caller's input, comparable to an HTTP 4xx.
 */
export class ToolCallerError extends Error {
  declare [toolCallerErrorBrand]: true;
  declare readonly kind?: ToolCallerErrorKind;
  /**
   * A stable, machine-readable code for this error, such as `invalid_cursor`.
   * Unlike `kind`, it is sent to the client: the error result's JSON carries
   * it as `error.code`, beside `name` and `message`, so a client can branch
   * on it without reading the message.
   */
  declare readonly code?: string;

  constructor(
    message: string,
    options?: ErrorOptions & { kind?: ToolCallerErrorKind; code?: string }
  ) {
    super(message, options);
    this.name = 'ToolCallerError';
    // Assigned here because a class field initializer miscompiles in the CJS build.
    this[toolCallerErrorBrand] = true;
    if (options?.kind !== undefined) {
      this.kind = options.kind;
    }
    if (options?.code !== undefined) {
      this.code = options.code;
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
