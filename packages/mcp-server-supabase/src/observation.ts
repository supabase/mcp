import type {
  ObservationContext as CoreObservationContext,
  RequestObservation as CoreRequestObservation,
  RequestObserver as CoreRequestObserver,
} from '@supabase/mcp-utils';
import type { ElicitationToolName } from './types.js';

export type { ObservationEnd, ObservedMethod } from '@supabase/mcp-utils';

export type ObservedTool = ElicitationToolName | 'other';

export type ConfirmationFeature = 'cost' | 'destructive_sql' | 'notebook';

/** Payload-free facts recorded by Supabase tools. */
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
        | 'not_destructive'
        | 'not_mutating';
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
      /** Ms from minting the prompt's state to the resume request reaching the tool; absent without a usable `issued_at`. */
      elapsed_ms?: number;
      /** Set only on a cancel faster than a person could answer. */
      instant?: true;
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
