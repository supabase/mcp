import type {
  IssuesPage,
  ShowIssuesViewData,
} from '@supabase/mcp-server-supabase/show-issues';
import { describe, expect, it } from 'vitest';
import {
  issueKey,
  OUT_OF_STEP_MESSAGE,
  parseIssuesPage,
  parseViewData,
} from './issues-schema';

const rls = {
  id: 'rls_disabled_in_public',
  category: 'security',
  title: 'RLS disabled in public',
  severity: 'critical',
  affected_count: 3,
} as const;
const index = {
  id: 'unindexed_foreign_keys',
  category: 'performance',
  title: 'Unindexed foreign keys',
  severity: 'warning',
  affected_count: 1,
} as const;

const page: IssuesPage = {
  issues: [rls, index],
  total: 23,
  counts: { all: 23, security: 10, performance: 12, health: 1 },
  checks: [
    { type: 'security', status: 'complete' },
    { type: 'health', status: 'unavailable', reason: 'Timed out' },
  ],
  next_cursor: 'abc',
  read_at: '2026-11-25T14:02:00.000Z',
};

const viewData: ShowIssuesViewData = {
  page,
  opened: { at: 1764079320000, project: 'abcdefghijklmnopqrst' },
  context: {
    project: { id: 'abcdefghijklmnopqrst', name: 'Design check' },
    connection: { readOnly: true, scopedProjectId: null },
  },
};

describe('parseIssuesPage', () => {
  it('reads a complete page as is', () => {
    expect(parseIssuesPage(page)).toEqual({ page, dropped: 0 });
  });

  it('falls back field by field when only the rows are there', () => {
    expect(parseIssuesPage({ issues: [rls] })).toEqual({
      page: { issues: [rls], checks: [], next_cursor: null },
      dropped: 0,
    });
  });

  it('treats wrongly typed optional fields as missing', () => {
    expect(
      parseIssuesPage({
        issues: [],
        total: '23',
        counts: { all: 1 },
        checks: 'none',
        next_cursor: 42,
        read_at: 0,
      })
    ).toEqual({
      page: { issues: [], checks: [], next_cursor: null },
      dropped: 0,
    });
  });

  it('ignores extra fields on the page, rows, counts and checks', () => {
    const { page: parsed } = parseIssuesPage({
      ...page,
      issues: [{ ...rls, description: 'New field' }],
      counts: { ...page.counts, info: 4 },
      checks: [{ type: 'security', status: 'complete', at: 1 }],
      version: 2,
    });
    expect(parsed.issues).toEqual([rls]);
    expect(parsed.counts).toEqual(page.counts);
    expect(parsed.checks).toEqual([{ type: 'security', status: 'complete' }]);
    expect(parsed).not.toHaveProperty('version');
  });

  it.each([
    ['a missing field', { ...rls, title: undefined }],
    ['a wrongly typed field', { ...rls, affected_count: '3' }],
    ['an unknown category', { ...rls, category: 'capacity' }],
    ['an unknown severity', { ...rls, severity: 'info' }],
    ['not an object', 'rls_disabled_in_public'],
    ['null', null],
  ])('drops and counts a row with %s', (_, row) => {
    expect(parseIssuesPage({ ...page, issues: [rls, row, index] })).toEqual({
      page: { ...page, issues: [rls, index] },
      dropped: 1,
    });
  });

  it('drops checks it cannot read', () => {
    const { page: parsed } = parseIssuesPage({
      issues: [],
      checks: [
        { type: 'capacity', status: 'complete' },
        { type: 'health', status: 'unknown' },
        { type: 'health', status: 'unavailable' },
      ],
    });
    expect(parsed.checks).toEqual([{ type: 'health', status: 'unavailable' }]);
  });

  it('reads an unsupported check with its reason', () => {
    const check = {
      type: 'health',
      status: 'unsupported',
      reason: 'Health issues are not supported by this platform',
    } as const;
    const { page: parsed } = parseIssuesPage({ issues: [], checks: [check] });
    expect(parsed.checks).toEqual([check]);
  });

  it.each([
    ['undefined', undefined],
    ['a string', 'Opened the issues view'],
    ['an array', [rls]],
    ['no issues', { total: 2 }],
    ['issues not a list', { issues: { 0: rls } }],
  ])('throws when the whole payload is %s', (_, raw) => {
    expect(() => parseIssuesPage(raw)).toThrow(OUT_OF_STEP_MESSAGE);
  });
});

describe('parseViewData', () => {
  it('reads complete view data as is', () => {
    expect(parseViewData(viewData)).toEqual({ data: viewData, dropped: 0 });
  });

  it('counts the dropped rows of its page', () => {
    expect(
      parseViewData({ ...viewData, page: { ...page, issues: [rls, {}] } })
        .dropped
    ).toBe(1);
  });

  it('leaves out opened and context when they are missing', () => {
    expect(parseViewData({ page: { issues: [] } })).toEqual({
      data: { page: { issues: [], checks: [], next_cursor: null } },
      dropped: 0,
    });
  });

  it('leaves out opened and context when they are unreadable', () => {
    const { data } = parseViewData({
      page,
      opened: { at: 'now' },
      context: { connection: {} },
    });
    expect(data.opened).toBeUndefined();
    expect(data.context).toBeUndefined();
  });

  it('keeps the parts of the context it can read', () => {
    const { data } = parseViewData({
      page,
      context: {
        project: { id: 'p', ref: 'r', name: 7 },
        connection: { readOnly: false, scopedProjectId: 'p' },
      },
    });
    expect(data.context).toEqual({
      project: { id: 'p', ref: 'r' },
      connection: { readOnly: false, scopedProjectId: 'p' },
    });
  });

  it.each([
    ['undefined', undefined],
    ['a page alone', page],
    ['a page with no rows', { page: { total: 1 } }],
  ])('throws when the whole payload is %s', (_, raw) => {
    expect(() => parseViewData(raw)).toThrow(OUT_OF_STEP_MESSAGE);
  });
});

describe('issueKey', () => {
  it('joins category and id', () => {
    expect(issueKey(rls)).toBe('security:rls_disabled_in_public');
  });
});
