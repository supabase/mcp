import { describe, expect, test } from 'vitest';
import { featureGroupSchema, type FeatureGroup } from './types.js';

describe('featureGroupsSchema', () => {
  test('accepts all valid feature groups', () => {
    const validFeatures = [
      'docs',
      'account',
      'database',
      'debugging',
      'development',
      'functions',
      'branching',
      'storage',
      'warehouse',
    ];

    for (const feature of validFeatures) {
      const result = featureGroupSchema.parse(feature);
      expect(result).toBe(feature);
    }
  });

  test('transforms deprecated group names', () => {
    const result = featureGroupSchema.parse('debug');
    expect(result).toBe('debugging');
  });

  test('rejects invalid feature groups', () => {
    expect(() => featureGroupSchema.parse('invalid')).toThrow();
    expect(() => featureGroupSchema.parse('')).toThrow();
    expect(() => featureGroupSchema.parse(null)).toThrow();
  });

  test('type inference works correctly', () => {
    const feature: FeatureGroup = 'debugging';
    expect(feature).toBe('debugging');
  });
});
