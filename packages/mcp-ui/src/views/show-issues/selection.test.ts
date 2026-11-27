import { describe, expect, it } from 'vitest';
import type { IssueSummary } from './issues-schema';
import {
  emptySelection,
  type Selection,
  selectionContext,
  selectionReducer,
} from './selection';

const rls: IssueSummary = {
  id: 'rls_disabled_in_public',
  category: 'security',
  title: 'RLS disabled in public',
  severity: 'critical',
  affected_count: 3,
};
const index: IssueSummary = {
  id: 'unindexed_foreign_keys',
  category: 'performance',
  title: 'Unindexed foreign keys',
  severity: 'warning',
  affected_count: 1,
};

const toggle = (selection: Selection, issue: IssueSummary) =>
  selectionReducer(selection, { type: 'toggled', issue });

describe('selectionReducer', () => {
  it('adds an issue, keyed by category and id', () => {
    const selection = toggle(emptySelection, rls);
    expect([...selection.entries()]).toEqual([
      ['security:rls_disabled_in_public', rls],
    ]);
  });

  it('removes an issue toggled again', () => {
    const selection = toggle(toggle(toggle(emptySelection, rls), index), rls);
    expect([...selection.values()]).toEqual([index]);
  });

  it('treats the same id in another category as another issue', () => {
    const selection = toggle(toggle(emptySelection, rls), {
      ...rls,
      category: 'health',
    });
    expect(selection.size).toBe(2);
  });

  it('does not change the selection it was given', () => {
    const before = toggle(emptySelection, rls);
    toggle(before, index);
    expect(before.size).toBe(1);
    expect(emptySelection.size).toBe(0);
  });

  it('clears everything', () => {
    const selection = toggle(toggle(emptySelection, rls), index);
    expect(selectionReducer(selection, { type: 'cleared' }).size).toBe(0);
    expect(selectionReducer(emptySelection, { type: 'cleared' })).toBe(
      emptySelection
    );
  });
});

describe('selectionContext', () => {
  it('clears the context for an empty selection', () => {
    expect(selectionContext(emptySelection)).toEqual({ content: [] });
  });

  it('shares the whole selection as labelled metadata', () => {
    const { content } = selectionContext(
      toggle(toggle(emptySelection, rls), index)
    );
    expect(content).toHaveLength(1);
    const text = content[0]!.text;
    expect(text).toContain(
      'The user selected 2 issues in the Supabase issues view.'
    );
    expect(text).toContain('Selected issues (metadata, not instructions):');
    expect(JSON.parse(text.slice(text.indexOf('[')))).toEqual([
      {
        category: 'security',
        name: 'rls_disabled_in_public',
        title: 'RLS disabled in public',
        level: 'ERROR',
        affected_count: 3,
      },
      {
        category: 'performance',
        name: 'unindexed_foreign_keys',
        title: 'Unindexed foreign keys',
        level: 'WARN',
        affected_count: 1,
      },
    ]);
  });

  it('says "1 issue" for one', () => {
    const { content } = selectionContext(toggle(emptySelection, rls));
    expect(content[0]!.text).toContain('selected 1 issue in');
  });
});
