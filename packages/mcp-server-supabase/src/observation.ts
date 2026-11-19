import type {
  ObservationContext as CoreObservationContext,
  RequestObservation as CoreRequestObservation,
  RequestObserver as CoreRequestObserver,
} from '@supabase/mcp-utils';
import type { ElicitationToolName } from './types.js';

export type { ObservationEnd, ObservedMethod } from '@supabase/mcp-utils';

export type ObservedTool = ElicitationToolName | 'other';

export type ConfirmationFeature = 'cost' | 'destructive_sql' | 'notebook';

/** One payload-free summary of a run that reached the notebook cell cap check. */
type NotebookRunFact =
  | Readonly<{
      kind: 'notebook_run';
      outcome: 'refused';
      reason: 'too_many_cells';
    }>
  | Readonly<{
      kind: 'notebook_run';
      outcome: 'completed';
      executed: number;
      skipped: number;
      errored: number;
      budget_exhausted: boolean;
    }>;

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
        | 'changed_quote'
        | 'expired';
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
    }>
  | Readonly<{
      /** One per call to the SQL confirmation classifier, recorded when the call settles. */
      kind: 'sql_classifier_call';
      /**
       * Only `destructive_sql` and `notebook` are recorded. The type stays wide for a host that narrows
       * to a feature this fact never has (for example one that keeps only `cost` facts) and then switches
       * over `kind`: a narrow type would drop this kind there, and the switch would compile without it.
       */
      feature: ConfirmationFeature;
      result:
        | 'not_destructive' // the classifier resolved with undefined
        | 'destructive'
        | 'do_heuristic'
        | 'unclassified'
        | 'oversized'
        | 'unavailable'
        | 'timeout'
        | 'crashed'
        | 'invalid' // a resolved value outside the contract
        | 'rejected' // the classifier threw or rejected
        | 'aborted'; // the request was cancelled while the classifier ran
      /** Ms from calling the classifier until it settled. */
      durationMs: number;
    }>
  | NotebookRunFact;

export type ObservationContext = CoreObservationContext<ObservedTool>;
export type RequestObservation = CoreRequestObservation<ObservationFact>;
export type RequestObserver = CoreRequestObserver<
  ObservedTool,
  ObservationFact
>;
