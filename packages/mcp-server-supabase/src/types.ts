import { z } from 'zod/v4';

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

export const PLATFORM_INDEPENDENT_FEATURES: FeatureGroup[] = ['docs'];
