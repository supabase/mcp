import { expect, test } from 'vitest';
import { filterAndSortIssues, normalizeIssues } from './issues.js';

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

test('critical filtering keeps every affected function and its remediation', () => {
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
      affected: [
        {
          id: 'first',
          resource: { type: 'function', schema: 'public', name: 'lookup()' },
          severity: 'info',
          detail: 'Fix `public.lookup`.',
          docs_url: 'https://example.com/first',
        },
        {
          id: 'second',
          resource: { name: 'lookup(id uuid)' },
          severity: 'critical',
          docs_url: 'https://example.com/second',
        },
      ],
    },
  ]);
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
  expect(result.issues[0]?.affected.map(({ resource }) => resource)).toEqual([
    { type: 'function', name: 'public.lookup(uuid)', schema: null },
    { type: 'project', name: 'Project', schema: null },
    { type: 'project', name: 'widgets', schema: 'custom' },
  ]);
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
