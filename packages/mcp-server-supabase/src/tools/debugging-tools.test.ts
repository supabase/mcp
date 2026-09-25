import { describe, expect, test } from 'vitest';
import type { components } from '../management-api/types.js';
import {
  DAY_MS,
  groupAdvisorLints,
  groupAdvisorsResult,
  resolveLogWindow,
} from './debugging-tools.js';

type AdvisorLint =
  components['schemas']['V1ProjectAdvisorsResponse_Output']['lints'][number];

describe('resolveLogWindow', () => {
  test('defaults the end to now and the start to 24 hours before it', () => {
    const before = Date.now();
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow();
    const after = Date.now();

    const endMs = Date.parse(iso_timestamp_end);
    const startMs = Date.parse(iso_timestamp_start);

    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
    expect(startMs).toBe(endMs - DAY_MS);
  });

  test('anchors the default start to a supplied end', () => {
    const end = '2024-02-01T11:00:00.000Z';
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow(
      undefined,
      end
    );

    expect(iso_timestamp_end).toBe(end);
    expect(iso_timestamp_start).toBe(
      new Date(Date.parse(end) - DAY_MS).toISOString()
    );
  });

  test('normalizes accepted timestamps to canonical UTC ISO strings', () => {
    const { iso_timestamp_start, iso_timestamp_end } = resolveLogWindow(
      '2024-02-01T09:00:00.000+01:00',
      '2024-02-01T11:00:00.000+01:00'
    );

    expect(iso_timestamp_start).toBe('2024-02-01T08:00:00.000Z');
    expect(iso_timestamp_end).toBe('2024-02-01T10:00:00.000Z');
  });

  test('rejects a malformed iso_timestamp_end', () => {
    expect(() => resolveLogWindow(undefined, 'not-a-timestamp')).toThrow(
      /Invalid iso_timestamp_end/
    );
  });

  test('rejects a malformed iso_timestamp_start', () => {
    expect(() =>
      resolveLogWindow('not-a-timestamp', '2024-02-01T11:00:00.000Z')
    ).toThrow(/Invalid iso_timestamp_start/);
  });

  test('rejects a start at or after the end', () => {
    expect(() =>
      resolveLogWindow('2024-02-01T11:00:00.000Z', '2024-02-01T10:00:00.000Z')
    ).toThrow(/must be before/);
  });

  test('rejects a window longer than 24 hours', () => {
    expect(() =>
      resolveLogWindow('2024-02-01T00:00:00.000Z', '2024-02-02T00:00:00.001Z')
    ).toThrow(/at most 24 hours/);
  });

  test('accepts a window exactly 24 hours long', () => {
    const start = '2024-02-01T00:00:00.000Z';
    const end = '2024-02-02T00:00:00.000Z';

    expect(() => resolveLogWindow(start, end)).not.toThrow();
  });
});

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
