import { describe, expect, test } from 'vitest';
import {
  MAX_AFFECTED_PER_ISSUE,
  filterAndSortIssues,
  normalizeIssues,
  readIssues,
} from './issues.js';
import type { DebuggingOperations } from './platform/types.js';

const lint = {
  name: 'function_search_path_mutable',
  title: 'Mutable search path',
  description: 'Check \\`search_path\\`.',
  detail: 'Fix \\`public.lookup\\`.',
  level: 'INFO',
  remediation: 'https://example.com/first',
  cache_key: 'first',
  metadata: { schema: 'public', name: 'lookup', arguments: '' },
};

test('critical filtering keeps sampled affected function and the docs link on the issue', () => {
  const result = normalizeIssues(
    {
      lints: [
        lint,
        {
          ...lint,
          level: 'ERROR',
          cache_key: 'second',
          remediation: 'https://example.com/second',
          metadata: { schema: 'public', name: 'lookup', arguments: 'id uuid' },
        },
      ],
    },
    'security'
  );
  expect(filterAndSortIssues(result.issues, 'critical')).toMatchObject([
    {
      id: 'function_search_path_mutable',
      severity: 'critical',
      description: 'Check `search_path`.',
      affected_count: 2,
      affected: [
        {
          id: 'second',
          resource: { name: 'lookup(id uuid)' },
          severity: 'critical',
        },
        {
          id: 'first',
          resource: { type: 'function', schema: 'public', name: 'lookup()' },
          severity: 'info',
          detail: 'Fix `public.lookup`.',
        },
      ],
    },
  ]);
  // Findings reach their docs link through the issue, not one copy each.
  expect(result.issues[0]?.docs_url).toBe('https://example.com/first');
  expect(result.issues[0]?.affected[0]).not.toHaveProperty('docs_url');
  expect(result.checks).toEqual([{ type: 'security', status: 'complete' }]);
});

test('resources preserve explicit identities and missing metadata without dropping findings', () => {
  const result = normalizeIssues(
    {
      lints: [
        {
          ...lint,
          metadata: {
            entity: 'public.lookup(uuid)',
            name: 'lookup',
            schema: 'public',
            type: 'function',
          },
        },
        { ...lint, cache_key: undefined, metadata: undefined },
        {
          ...lint,
          metadata: { type: 'future', name: 'widgets', schema: 'custom' },
        },
      ],
    },
    'security'
  );
  expect(result.issues[0]?.affected.map(({ resource }) => resource)).toEqual(
    expect.arrayContaining([
      { type: 'function', name: 'public.lookup(uuid)', schema: null },
      { type: 'project', name: 'Project', schema: null },
      { type: 'project', name: 'widgets', schema: 'custom' },
    ])
  );
  expect(result.issues[0]?.affected[1]?.id).toBeTruthy();
});

test('unavailable health checks cannot look like a clean assessment', () => {
  const result = normalizeIssues(
    {
      lints: [
        { ...lint, name: 'advisor_check_unavailable' },
        { ...lint, name: 'log_auth_error_rate_high' },
      ],
    },
    'health'
  );
  expect(result.checks).toEqual([
    {
      type: 'health',
      status: 'unavailable',
      reason: 'advisor_check_unavailable: Fix `public.lookup`.',
    },
  ]);
  expect(result.issues.map(({ id }) => id)).toEqual([
    'log_auth_error_rate_high',
  ]);
});

test.each([
  {},
  { lints: null },
  { lints: [null] },
  { lints: [{ ...lint, level: 'FUTURE' }] },
  { lints: [{ ...lint, detail: null }] },
])('malformed checks never become empty success: %j', (response) => {
  expect(() => normalizeIssues(response, 'security')).toThrow();
});

test('severity leads the output, with stable check IDs breaking ties', () => {
  const { issues } = normalizeIssues(
    {
      lints: [
        { ...lint, name: 'z', level: 'WARN' },
        { ...lint, name: 'a', level: 'WARN' },
        { ...lint, name: 'critical', level: 'ERROR' },
        { ...lint, name: 'info' },
      ],
    },
    'performance'
  );
  expect(filterAndSortIssues(issues, 'warning').map(({ id }) => id)).toEqual([
    'critical',
    'a',
    'z',
  ]);
});

test('issues bound evidence, count all findings, and prioritize critical findings deterministically', () => {
  const lints = Array.from({ length: 25 }, (_, i) => ({
    ...lint,
    cache_key: String(i).padStart(2, '0'),
    level: i === 24 ? 'ERROR' : 'INFO',
  }));
  const first = normalizeIssues({ lints }, 'security').issues[0]!;
  const reversed = normalizeIssues({ lints: [...lints].reverse() }, 'security')
    .issues[0]!;
  expect(first.affected_count).toBe(25);
  expect(first.affected).toHaveLength(MAX_AFFECTED_PER_ISSUE);
  expect(first.affected[0]).toMatchObject({ id: '24', severity: 'critical' });
  expect(first).toEqual(reversed);
});

test('issues accept self-hosted lint arrays without changing their findings', () => {
  expect(normalizeIssues([lint], 'security')).toEqual(
    normalizeIssues({ lints: [lint] }, 'security')
  );
});

describe('readIssues', () => {
  const debugging = (
    overrides: Partial<DebuggingOperations> = {}
  ): DebuggingOperations => ({
    async getLogs() {
      return [];
    },
    async getSecurityAdvisors() {
      return { lints: [] };
    },
    async getPerformanceAdvisors() {
      return { lints: [] };
    },
    ...overrides,
  });

  test('a category without an adapter is unsupported, not attempted or failed', async () => {
    const result = await readIssues(debugging(), 'project', 'all');
    expect(result).toEqual({
      issues: [],
      checks: [
        { type: 'security', status: 'complete' },
        { type: 'performance', status: 'complete' },
        {
          type: 'health',
          status: 'unsupported',
          reason: 'Health issues are not supported by this platform',
        },
      ],
    });
  });

  test('a failed health read is unavailable, not unsupported', async () => {
    const result = await readIssues(
      debugging({
        async getHealthAdvisors() {
          throw new Error('Health is down');
        },
      }),
      'project',
      'health'
    );
    expect(result.checks).toEqual([
      { type: 'health', status: 'unavailable', reason: 'Health is down' },
    ]);
  });
});
