import { describe, expect, test } from 'vitest';
import type {
  Issue,
  IssueCategory,
  IssueSeverity,
  IssuesResult,
} from './issues.js';
import {
  decodeIssuesCursor,
  encodeIssuesCursor,
  InvalidIssuesCursorError,
  ISSUES_PAGE_DEFAULT_LIMIT,
  pageIssues,
  type IssuesPage,
  type SortKey,
} from './issues-page.js';

const readAt = new Date('2026-11-25T12:00:00.000Z');
const limit = ISSUES_PAGE_DEFAULT_LIMIT;

function issue(
  id: string,
  category: IssueCategory,
  severity: IssueSeverity,
  affected_count = 1
): Issue {
  return {
    id,
    title: `Title ${id}`,
    description: 'Description',
    severity,
    category,
    source: 'lint',
    docs_url: 'https://supabase.com/docs',
    affected_count,
    affected: [],
  };
}

const complete: IssuesResult['checks'] = [
  { type: 'security', status: 'complete' },
  { type: 'performance', status: 'complete' },
  { type: 'health', status: 'complete' },
];

function result(issues: Issue[]): IssuesResult {
  return { issues, checks: complete };
}

const ids = (page: IssuesPage) =>
  page.issues.map(({ category, id }) => `${category}:${id}`);

/** Follows `next_cursor` to the end, reading a fresh result for each page. */
function pageAll(
  read: (page: number) => IssuesResult,
  options: { type?: 'all' | IssueCategory; limit: number }
) {
  const pages: IssuesPage[] = [];
  let after: SortKey | undefined;
  do {
    const page = pageIssues(read(pages.length), { ...options, after, readAt });
    pages.push(page);
    after = page.next_cursor
      ? decodeIssuesCursor(page.next_cursor, options.type ?? 'all')
      : undefined;
  } while (after);
  return pages;
}

describe('pageIssues', () => {
  test('sorts by severity, then category, then id, and leaves out info issues', () => {
    const page = pageIssues(
      result([
        issue('b_health', 'health', 'warning'),
        issue('a_perf', 'performance', 'critical'),
        issue('z_sec', 'security', 'warning'),
        issue('info_sec', 'security', 'info'),
        issue('b_sec', 'security', 'critical'),
        issue('a_sec', 'security', 'critical'),
        issue('a_health', 'health', 'critical'),
        // Code-unit order: upper case sorts before lower case.
        issue('Z_sec', 'security', 'warning'),
      ]),
      { limit, readAt }
    );

    expect(ids(page)).toEqual([
      'security:a_sec',
      'security:b_sec',
      'performance:a_perf',
      'health:a_health',
      'security:Z_sec',
      'security:z_sec',
      'health:b_health',
    ]);
    expect(page.issues[0]).toEqual({
      id: 'a_sec',
      category: 'security',
      title: 'Title a_sec',
      severity: 'critical',
      affected_count: 1,
    });
    expect(page.total).toBe(7);
    expect(page.next_cursor).toBeNull();
    expect(page.read_at).toBe('2026-11-25T12:00:00.000Z');
    expect(page.checks).toEqual(complete);
  });

  test('counts cover the whole project and total covers the requested type', () => {
    const issues = [
      issue('s1', 'security', 'critical'),
      issue('s2', 'security', 'warning'),
      issue('s3', 'security', 'info'),
      issue('p1', 'performance', 'warning'),
      issue('h1', 'health', 'info'),
    ];

    const page = pageIssues(result(issues), {
      type: 'performance',
      limit,
      readAt,
    });

    expect(ids(page)).toEqual(['performance:p1']);
    expect(page.total).toBe(1);
    expect(page.counts).toEqual({
      all: 3,
      security: 2,
      performance: 1,
      health: 0,
    });
  });

  test('keeps unavailable and unsupported checks', () => {
    const checks: IssuesResult['checks'] = [
      { type: 'security', status: 'complete' },
      { type: 'health', status: 'unavailable', reason: 'down' },
      {
        type: 'performance',
        status: 'unsupported',
        reason: 'Not offered',
      },
    ];

    const page = pageIssues(
      { issues: [issue('s1', 'security', 'warning')], checks },
      { limit, readAt }
    );

    expect(page.checks).toEqual(checks);
  });

  test('pages to the end without gaps or repeats', () => {
    const issues = Array.from({ length: 23 }, (_, i) =>
      issue(
        `check_${String(i).padStart(2, '0')}`,
        (['security', 'performance', 'health'] as const)[i % 3]!,
        i % 2 ? 'warning' : 'critical'
      )
    );
    const expected = ids(pageIssues(result(issues), { limit: 50, readAt }));

    const pages = pageAll(() => result(issues), { limit: 10 });

    expect(pages.map((page) => page.issues.length)).toEqual([10, 10, 3]);
    expect(pages.flatMap(ids)).toEqual(expected);
    expect(pages.every((page) => page.total === 23)).toBe(true);
  });

  test('pages a single type', () => {
    const issues = [
      issue('s1', 'security', 'warning'),
      issue('p1', 'performance', 'critical'),
      issue('s2', 'security', 'critical'),
      issue('s3', 'security', 'warning'),
    ];

    const pages = pageAll(() => result(issues), { type: 'security', limit: 2 });

    expect(pages.map(ids)).toEqual([
      ['security:s2', 'security:s1'],
      ['security:s3'],
    ]);
  });

  test('an exact final page has no next cursor', () => {
    const issues = [
      issue('a', 'security', 'warning'),
      issue('b', 'security', 'warning'),
    ];

    const page = pageIssues(result(issues), { limit: 2, readAt });

    expect(page.issues).toHaveLength(2);
    expect(page.next_cursor).toBeNull();
  });

  test('an empty project has one empty page', () => {
    const page = pageIssues(result([]), { limit, readAt });

    expect(page).toEqual({
      issues: [],
      total: 0,
      counts: { all: 0, security: 0, performance: 0, health: 0 },
      checks: complete,
      next_cursor: null,
      read_at: '2026-11-25T12:00:00.000Z',
    });
  });
});

describe('issues cursor', () => {
  const toBase64Url = (value: string) =>
    btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  test('round trips the sort key', () => {
    const cursor = encodeIssuesCursor('security', [
      'warning',
      'security',
      'rls_disabled_in_public',
    ]);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeIssuesCursor(cursor, 'security')).toEqual([
      'warning',
      'security',
      'rls_disabled_in_public',
    ]);
  });

  test.each([
    ['garbage', 'not a cursor!'],
    ['not JSON', toBase64Url('{oops')],
    [
      'a wrong version',
      toBase64Url(
        JSON.stringify({ v: 2, type: 'all', after: ['warning', 'health', 'x'] })
      ),
    ],
    [
      'an unknown severity',
      toBase64Url(
        JSON.stringify({ v: 1, type: 'all', after: ['info', 'health', 'x'] })
      ),
    ],
    ['a missing key', toBase64Url(JSON.stringify({ v: 1, type: 'all' }))],
  ])('rejects %s', (_, cursor) => {
    expect(() => decodeIssuesCursor(cursor, 'all')).toThrow(
      InvalidIssuesCursorError
    );
  });

  test('rejects a cursor made for another type', () => {
    const cursor = encodeIssuesCursor('security', ['warning', 'security', 'a']);

    expect(() => decodeIssuesCursor(cursor, 'performance')).toThrow(
      InvalidIssuesCursorError
    );
    expect(() => decodeIssuesCursor(cursor, 'all')).toThrow(
      InvalidIssuesCursorError
    );
  });
});
