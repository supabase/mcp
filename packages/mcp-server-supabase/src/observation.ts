import type {
  ObservationContext as CoreObservationContext,
  RequestObservation as CoreRequestObservation,
  RequestObserver as CoreRequestObserver,
} from '@supabase/mcp-utils';

export type { ObservationEnd, ObservedMethod } from '@supabase/mcp-utils';

export type ObservedTool =
  | 'create_project'
  | 'create_branch'
  | 'execute_sql'
  | 'apply_migration'
  | 'other';

export type ConfirmationFeature = 'cost' | 'destructive_sql';

/**
 * Bounded, payload-free facts for confirmation and backend invocation attempts.
 *
 * Fact and discriminator unions are finite for each version but can grow.
 * Consumers must handle additional values when upgrading.
 * `not_destructive` is a classifier result, not a SQL safety or authorization verdict.
 *
 * Operation facts describe backend invocation: `returned` does not prove readiness
 * or commit, and `threw` does not prove that nothing committed. For `destructive_sql`,
 * they also cover SELECT, read-only calls, and calls that bypass confirmation due
 * to configuration or missing capabilities, when those calls reach the backend.
 * Blocked calls, confirmation prompts, and honored declines or cancellations
 * emit no operation facts.
 */
export type ObservationFact =
  | Readonly<{
      kind: 'confirmation_decision';
      feature: ConfirmationFeature;
      route: 'inline' | 'legacy' | 'bypass' | 'blocked';
      reason:
        | 'eligible'
        | 'not_configured'
        | 'capability_missing'
        | 'read_only'
        | 'zero_cost'
        | 'not_destructive';
    }>
  | Readonly<{
      kind: 'input_required';
      feature: ConfirmationFeature;
      mode: 'form';
      reason: 'initial' | 'missing_response' | 'changed_quote';
    }>
  | Readonly<{
      kind: 'input_response';
      feature: ConfirmationFeature;
      action: 'accept' | 'decline' | 'cancel';
    }>
  | Readonly<{
      kind: 'resume_validation';
      feature: ConfirmationFeature;
      result:
        | 'valid'
        | 'missing_response'
        | 'tool_mismatch'
        | 'arguments_mismatch'
        | 'changed_quote';
    }>
  | Readonly<{
      kind: 'operation';
      feature: ConfirmationFeature;
      disposition: 'started';
    }>
  | Readonly<{
      kind: 'operation';
      feature: ConfirmationFeature;
      disposition: 'returned' | 'threw';
      durationMs: number;
    }>;

export type ObservationContext = CoreObservationContext<ObservedTool>;
export type RequestObservation = CoreRequestObservation<ObservationFact>;
export type RequestObserver = CoreRequestObserver<
  ObservedTool,
  ObservationFact
>;
