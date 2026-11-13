import { describe, expect, test } from 'vitest';
import { supabaseMcpToolSchemas } from './tool-schemas.js';
import {
  createOAuthScopeHints,
  createToolAccessHints,
  supabaseMcpToolAccessHints,
} from './tool-access.js';

describe('tool access hints', () => {
  test('covers every published tool schema', () => {
    expect(Object.keys(supabaseMcpToolAccessHints).sort()).toEqual(
      Object.keys(supabaseMcpToolSchemas).sort()
    );
  });

  test('docs-only configuration requires no OAuth scope hints', () => {
    expect(createOAuthScopeHints({ features: ['docs'] })).toEqual([]);
  });

  test('read-only database mode downgrades execute_sql to database:read', () => {
    expect(
      createOAuthScopeHints({
        features: ['database'],
        readOnly: true,
      })
    ).toEqual(['database:read']);
  });

  test('project-scoped mode excludes account-level requirements', () => {
    expect(
      createOAuthScopeHints({
        features: ['account', 'database'],
        projectScoped: true,
      })
    ).toEqual(['database:read', 'database:write']);
  });

  test('development tools only add the scopes they actually need', () => {
    expect(
      createOAuthScopeHints({
        features: ['account', 'development'],
      })
    ).toEqual([
      'database:read',
      'organizations:read',
      'projects:read',
      'projects:write',
      'secrets:read',
    ]);
  });

  test('inferred scope families are opt-in', () => {
    expect(
      createOAuthScopeHints({
        features: ['debugging', 'storage'],
      })
    ).toEqual([]);

    expect(
      createOAuthScopeHints({
        features: ['debugging', 'storage'],
        includeInferred: true,
      })
    ).toEqual([
      'advisors:read',
      'analytics:read',
      'storage:read',
      'storage:write',
    ]);
  });

  test('tool access filtering mirrors feature and read-only filtering', () => {
    const hints = createToolAccessHints({
      features: ['database', 'docs'],
      readOnly: true,
    });

    expect(Object.keys(hints).sort()).toEqual([
      'execute_sql',
      'list_extensions',
      'list_migrations',
      'list_tables',
      'search_docs',
    ]);
  });
});
