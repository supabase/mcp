import { describe, expect, test } from 'vitest';
import type { components } from '../management-api/types.js';
import { groupAdvisorLints, groupAdvisorsResult } from './debugging-tools.js';

type AdvisorLint =
  components['schemas']['V1ProjectAdvisorsResponse_Output']['lints'][number];

describe('groupAdvisorLints', () => {
  function lint(overrides: Record<string, unknown> = {}): AdvisorLint {
    return {
      name: 'function_search_path_mutable',
      title: 'Function Search Path Mutable',
      level: 'WARN',
      facing: 'EXTERNAL',
      categories: ['SECURITY'],
      description:
        'Detects functions where the search_path parameter is not set.',
      detail: 'Function `public.a` has a role mutable search_path',
      remediation: 'https://supabase.com/docs/guides/database/database-linter',
      metadata: { schema: 'public', name: 'a', type: 'function' },
      cache_key: 'function_search_path_mutable_public_a',
      ...overrides,
    };
  }

  test('collapses repeated lints into one entry', () => {
    const grouped = groupAdvisorLints([
      lint(),
      lint({
        detail: 'Function `public.b` has a role mutable search_path',
        metadata: { schema: 'public', name: 'b', type: 'function' },
        cache_key: 'function_search_path_mutable_public_b',
      }),
    ]);

    expect(grouped).toEqual([
      {
        name: 'function_search_path_mutable',
        title: 'Function Search Path Mutable',
        level: 'WARN',
        facing: 'EXTERNAL',
        categories: ['SECURITY'],
        description:
          'Detects functions where the search_path parameter is not set.',
        remediation:
          'https://supabase.com/docs/guides/database/database-linter',
        count: 2,
        findings: [
          {
            detail: 'Function `public.a` has a role mutable search_path',
            metadata: { schema: 'public', name: 'a', type: 'function' },
          },
          {
            detail: 'Function `public.b` has a role mutable search_path',
            metadata: { schema: 'public', name: 'b', type: 'function' },
          },
        ],
      },
    ]);
  });

  test('keeps unknown fields on the finding', () => {
    const [group] = groupAdvisorLints([
      lint({ observed_at: '2026-08-22T11:20:43.184Z', future_field: 42 }),
    ]);

    expect(group?.findings[0]).toMatchObject({
      detail: 'Function `public.a` has a role mutable search_path',
      observed_at: '2026-08-22T11:20:43.184Z',
      future_field: 42,
    });
  });

  test('drops cache_key', () => {
    const [group] = groupAdvisorLints([lint()]);

    expect(group?.findings[0]).not.toHaveProperty('cache_key');
    expect(group).not.toHaveProperty('cache_key');
  });

  test('splits lints sharing a name but differing on a shared field', () => {
    const grouped = groupAdvisorLints([
      lint({ name: 'rls_enabled_no_policy', level: 'INFO' }),
      lint({ name: 'rls_enabled_no_policy', level: 'WARN' }),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.map((group) => group.level)).toEqual(['INFO', 'WARN']);
  });

  test('preserves first-seen order', () => {
    const grouped = groupAdvisorLints([
      lint({ name: 'unused_index' }),
      lint(),
      lint({ name: 'unused_index' }),
    ]);

    expect(grouped.map((group) => [group.name, group.count])).toEqual([
      ['unused_index', 2],
      ['function_search_path_mutable', 1],
    ]);
  });

  test('handles an empty list', () => {
    expect(groupAdvisorLints([])).toEqual([]);
  });

  test('keeps a lint with an explicit null shared field separate from one missing the field', () => {
    const explicitNull = lint({ remediation: null });
    const { remediation, ...missingRemediation } = lint();

    const grouped = groupAdvisorLints([explicitNull, missingRemediation]);

    expect(grouped).toHaveLength(2);
  });
});

describe('groupAdvisorsResult', () => {
  test('groups lints and preserves sibling fields', () => {
    const result = groupAdvisorsResult({
      lints: [
        {
          name: 'unused_index',
          title: 'Unused Index',
          level: 'INFO',
          detail: 'Index `idx_a` has not been used',
        },
        {
          name: 'unused_index',
          title: 'Unused Index',
          level: 'INFO',
          detail: 'Index `idx_b` has not been used',
        },
      ],
      other_field: 'untouched',
    });

    expect(result).toEqual({
      lints: [
        {
          name: 'unused_index',
          title: 'Unused Index',
          level: 'INFO',
          count: 2,
          findings: [
            { detail: 'Index `idx_a` has not been used' },
            { detail: 'Index `idx_b` has not been used' },
          ],
        },
      ],
      other_field: 'untouched',
    });
  });

  test('passes through an unrecognised payload', () => {
    for (const result of [
      undefined,
      null,
      'nope',
      {},
      { lints: 'nope' },
      { lints: [1, 2] },
    ]) {
      expect(groupAdvisorsResult(result)).toEqual(result);
    }
  });
});
