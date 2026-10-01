import type { ObservedTool } from '@supabase/mcp-utils';
import { z } from 'zod/v4';

export const CURRENT_ELICITATION_TOOLS = [
  'create_project',
  'create_branch',
  'execute_sql',
  'apply_migration',
] as const satisfies readonly ObservedTool[];

export type ElicitationToolName = (typeof CURRENT_ELICITATION_TOOLS)[number];

export const CURRENT_FEATURE_GROUPS = [
  'docs',
  'account',
  'database',
  'debugging',
  'development',
  'functions',
  'branching',
  'storage',
] as const;

export const deprecatedFeatureGroupSchema = z.enum(['debug']);

export const currentFeatureGroupSchema = z.enum(CURRENT_FEATURE_GROUPS);

export const featureGroupSchema = z
  .union([deprecatedFeatureGroupSchema, currentFeatureGroupSchema])
  .transform((value) => {
    // Convert deprecated groups to their new name
    switch (value) {
      case 'debug':
        return 'debugging';
      default:
        return value;
    }
  });

export type FeatureGroup = z.infer<typeof featureGroupSchema>;
