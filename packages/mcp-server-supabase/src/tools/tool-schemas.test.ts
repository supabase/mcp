import { z } from 'zod/v4';
import { describe, expect, expectTypeOf, test } from 'vitest';
import {
  createToolSchemas,
  defsToSchemas,
  supabaseMcpToolSchemas,
} from './tool-schemas.js';
import type { ToolDefs } from './util.js';

describe('defsToSchemas', () => {
  test('propagates hidden from a tool def into its schema entry', () => {
    const defs = {
      visible_tool: {
        parameters: z.object({}),
        outputSchema: z.object({}),
        annotations: { title: 'Visible tool' },
      },
      hidden_tool: {
        parameters: z.object({}),
        outputSchema: z.object({}),
        annotations: { title: 'Hidden tool' },
        hidden: true,
      },
    } satisfies ToolDefs;

    const schemas = defsToSchemas(defs);

    expect(schemas.visible_tool.hidden).toBeUndefined();
    expect(schemas.hidden_tool.hidden).toBe(true);
  });
});

describe('createToolSchemas', () => {
  describe('no options (default)', () => {
    test('returns all tools', () => {
      const schemas = createToolSchemas();
      expect(Object.keys(schemas).sort()).toEqual(
        Object.keys(supabaseMcpToolSchemas).sort()
      );
    });

    test('schemas match original schemas', () => {
      const schemas = createToolSchemas();
      for (const [name, schema] of Object.entries(supabaseMcpToolSchemas)) {
        expect(schemas[name as keyof typeof schemas]).toBe(schema);
      }
    });
  });

  describe('feature filtering', () => {
    test('only includes tools for specified features', () => {
      const schemas = createToolSchemas({ features: ['database', 'docs'] });
      expect(Object.keys(schemas).sort()).toEqual([
        'apply_migration',
        'execute_sql',
        'list_extensions',
        'list_migrations',
        'list_tables',
        'search_docs',
      ]);
    });

    test('type narrows to only specified feature tools', () => {
      const schemas = createToolSchemas({ features: ['database', 'docs'] });

      // Should be present
      expectTypeOf(schemas).toHaveProperty('execute_sql');
      expectTypeOf(schemas).toHaveProperty('search_docs');

      // Should NOT be present
      expectTypeOf(schemas).not.toHaveProperty('list_organizations');
      expectTypeOf(schemas).not.toHaveProperty('deploy_edge_function');
    });

    test('single feature', () => {
      const schemas = createToolSchemas({ features: ['docs'] });
      expect(Object.keys(schemas)).toEqual(['search_docs']);

      // Type narrows to only search_docs
      expectTypeOf(schemas).toHaveProperty('search_docs');
      expectTypeOf(schemas).not.toHaveProperty('execute_sql');
    });
  });

  describe('PROJECT_SCOPED_OVERRIDES completeness', () => {
    test('all tools with project_id in inputSchema have it omitted in project-scoped mode', () => {
      const projectScopedSchemas = createToolSchemas({ projectScoped: true });

      for (const [name, { inputSchema }] of Object.entries(
        supabaseMcpToolSchemas
      )) {
        if (!('project_id' in inputSchema.shape)) continue;

        // Account tools are excluded entirely from project-scoped mode - skip them
        if (!(name in projectScopedSchemas)) continue;

        const projectScopedEntry =
          projectScopedSchemas[name as keyof typeof projectScopedSchemas];
        const projectScopedShape = projectScopedEntry.inputSchema.shape;

        expect(
          projectScopedShape,
          `Tool "${name}" has project_id in inputSchema but it is not omitted in project-scoped mode — add it to PROJECT_SCOPED_OVERRIDES`
        ).not.toHaveProperty('project_id');
      }
    });
  });

  describe('projectScoped', () => {
    test('excludes account tools', () => {
      const schemas = createToolSchemas({ projectScoped: true });
      const keys = Object.keys(schemas);

      expect(keys).not.toContain('list_organizations');
    });

    test('type excludes account tools', () => {
      const schemas = createToolSchemas({ projectScoped: true });
      expectTypeOf(schemas).not.toHaveProperty('list_organizations');
      expectTypeOf(schemas).not.toHaveProperty('create_project');
    });

    test('omits project_id from applicable input schemas', () => {
      const schemas = createToolSchemas({ projectScoped: true });

      // execute_sql should not have project_id
      const { shape } = schemas.execute_sql.inputSchema;
      expect(shape).not.toHaveProperty('project_id');
      expect(shape).toHaveProperty('query');
    });
  });

  describe('branch-only cost helpers', () => {
    test('boolean project scope retains account and branch-only quote alternatives', () => {
      const schemas = createToolSchemas({
        features: ['account', 'branching'],
        projectScoped: false as boolean,
      });
      const scopedSchemas = createToolSchemas({
        features: ['account', 'branching'],
        projectScoped: true,
      });
      expectTypeOf<
        z.input<typeof schemas.get_cost.inputSchema>
      >().toEqualTypeOf<
        | { type: 'project' | 'branch'; organization_id: string }
        | { type: 'branch' }
      >();
      expectTypeOf<typeof schemas.get_cost.outputSchema>().toEqualTypeOf<
        | typeof supabaseMcpToolSchemas.get_cost.outputSchema
        | typeof scopedSchemas.get_cost.outputSchema
      >();
      expectTypeOf<
        z.output<typeof schemas.get_cost.outputSchema>
      >().toEqualTypeOf<
        | {
            type: 'project' | 'branch';
            amount: number;
            recurrence: 'hourly' | 'monthly';
          }
        | {
            type: 'branch';
            amount: number;
            recurrence: 'hourly' | 'monthly';
          }
      >();
      const input = { type: 'project', organization_id: 'fixture-org' };
      expect(schemas.get_cost.inputSchema.parse(input)).toEqual(input);
      expect(
        schemas.get_cost.inputSchema.safeParse({ type: 'branch' }).success
      ).toBe(false);
    });

    test('boolean read-only retains both helper-present and helper-absent maps', () => {
      const schemas = createToolSchemas({
        features: ['branching'],
        readOnly: false as boolean,
      });
      const writableSchemas = createToolSchemas({ features: ['branching'] });
      const readOnlySchemas = createToolSchemas({
        features: ['branching'],
        readOnly: true,
      });
      expectTypeOf(schemas).toEqualTypeOf<
        typeof writableSchemas | typeof readOnlySchemas
      >();
      expectTypeOf<
        Extract<typeof schemas, { get_cost: unknown }>
      >().toEqualTypeOf<typeof writableSchemas>();
      expectTypeOf<
        Exclude<typeof schemas, { get_cost: unknown }>
      >().toEqualTypeOf<typeof readOnlySchemas>();
      expect(schemas).toHaveProperty('get_cost');
      expect(schemas).toHaveProperty('confirm_cost');
    });

    test.each([
      {
        name: 'scoped defaults',
        create: () => createToolSchemas({ projectScoped: true }),
      },
      {
        name: 'scoped branching-only',
        create: () =>
          createToolSchemas({ features: ['branching'], projectScoped: true }),
      },
      {
        name: 'unscoped branching-only',
        create: () => createToolSchemas({ features: ['branching'] }),
      },
    ])(
      '$name exposes branch-only cost input and output types',
      ({ create }) => {
        const schemas = create();
        expectTypeOf(schemas).toHaveProperty('get_cost');
        expectTypeOf(schemas).toHaveProperty('confirm_cost');
        expectTypeOf<
          z.input<typeof schemas.get_cost.inputSchema>
        >().toEqualTypeOf<{
          type: 'branch';
        }>();
        expectTypeOf<
          z.input<typeof schemas.confirm_cost.inputSchema>
        >().toEqualTypeOf<{
          type: 'branch';
          amount: number;
          recurrence: 'hourly' | 'monthly';
        }>();
        expectTypeOf<
          z.output<typeof schemas.get_cost.outputSchema>
        >().toEqualTypeOf<{
          type: 'branch';
          amount: number;
          recurrence: 'hourly' | 'monthly';
        }>();
        expectTypeOf<
          z.output<typeof schemas.confirm_cost.outputSchema>
        >().toEqualTypeOf<{ confirmation_id: string }>();

        const quote = { type: 'branch', amount: 0.01344, recurrence: 'hourly' };
        expect(schemas.get_cost.inputSchema.parse({ type: 'branch' })).toEqual({
          type: 'branch',
        });
        expect(schemas.get_cost.inputSchema.shape).not.toHaveProperty(
          'organization_id'
        );
        expect(
          schemas.get_cost.inputSchema.safeParse({ type: 'project' }).success
        ).toBe(false);
        expect(schemas.confirm_cost.inputSchema.parse(quote)).toEqual(quote);
        expect(
          schemas.confirm_cost.inputSchema.safeParse({
            ...quote,
            type: 'project',
          }).success
        ).toBe(false);
        expect(
          schemas.confirm_cost.inputSchema.safeParse({
            type: 'branch',
            recurrence: 'hourly',
          }).success
        ).toBe(false);
        expect(
          schemas.confirm_cost.inputSchema.safeParse({
            type: 'branch',
            amount: quote.amount,
          }).success
        ).toBe(false);
        expect(schemas.get_cost.outputSchema.parse(quote)).toEqual(quote);
        expect(
          schemas.get_cost.outputSchema.safeParse({
            ...quote,
            type: 'project',
          }).success
        ).toBe(false);
        expect(
          schemas.confirm_cost.outputSchema.parse({
            confirmation_id: 'cost-id',
          })
        ).toEqual({ confirmation_id: 'cost-id' });
      }
    );

    test.each([
      {
        name: 'read-only scoped defaults',
        create: () =>
          createToolSchemas({ projectScoped: true, readOnly: true }),
      },
      {
        name: 'read-only scoped branching',
        create: () =>
          createToolSchemas({
            features: ['branching'],
            projectScoped: true,
            readOnly: true,
          }),
      },
      {
        name: 'read-only unscoped branching',
        create: () =>
          createToolSchemas({ features: ['branching'], readOnly: true }),
      },
      {
        name: 'scoped account without branching',
        create: () =>
          createToolSchemas({ features: ['account'], projectScoped: true }),
      },
      {
        name: 'unscoped without account or branching',
        create: () => createToolSchemas({ features: ['database'] }),
      },
    ])(
      '$name omits branch-only helpers from runtime and inferred keys',
      ({ create }) => {
        const schemas = create();
        expect(schemas).not.toHaveProperty('get_cost');
        expect(schemas).not.toHaveProperty('confirm_cost');
        expectTypeOf(schemas).not.toHaveProperty('get_cost');
        expectTypeOf(schemas).not.toHaveProperty('confirm_cost');
        // Check every factory's return type, not only the union's common keys.
        expectTypeOf<
          Extract<typeof schemas, { get_cost: unknown }>
        >().toEqualTypeOf<never>();
        expectTypeOf<
          Extract<typeof schemas, { confirm_cost: unknown }>
        >().toEqualTypeOf<never>();
      }
    );

    test.each([
      {
        name: 'account only',
        create: () => createToolSchemas({ features: ['account'] }),
      },
      {
        name: 'account and branching',
        create: () => createToolSchemas({ features: ['account', 'branching'] }),
      },
      {
        name: 'read-only account and branching',
        create: () =>
          createToolSchemas({
            features: ['account', 'branching'],
            readOnly: true,
          }),
      },
    ])(
      '$name preserves account cost schemas and inferred types',
      ({ create }) => {
        const schemas = create();
        expectTypeOf<
          z.input<typeof schemas.get_cost.inputSchema>
        >().toEqualTypeOf<{
          type: 'project' | 'branch';
          organization_id: string;
        }>();
        expectTypeOf<
          z.input<typeof schemas.confirm_cost.inputSchema>
        >().toEqualTypeOf<{
          type: 'project' | 'branch';
          amount: number;
          recurrence: 'hourly' | 'monthly';
        }>();
        expectTypeOf<
          z.output<typeof schemas.get_cost.outputSchema>
        >().toEqualTypeOf<{
          type: 'project' | 'branch';
          amount: number;
          recurrence: 'hourly' | 'monthly';
        }>();
        expectTypeOf<
          z.output<typeof schemas.confirm_cost.outputSchema>
        >().toEqualTypeOf<{ confirmation_id: string }>();
        for (const type of ['project', 'branch'] as const) {
          const input = { type, organization_id: 'fixture-org' };
          const quote = { type, amount: 1, recurrence: 'monthly' };
          expect(schemas.get_cost.inputSchema.parse(input)).toEqual(input);
          expect(schemas.get_cost.inputSchema.safeParse({ type }).success).toBe(
            false
          );
          expect(schemas.confirm_cost.inputSchema.parse(quote)).toEqual(quote);
          expect(schemas.get_cost.outputSchema.parse(quote)).toEqual(quote);
        }
      }
    );
  });

  describe('readOnly', () => {
    test('excludes write-only tools', () => {
      const schemas = createToolSchemas({ readOnly: true });
      const keys = Object.keys(schemas);

      expect(keys).not.toContain('apply_migration');
    });

    test('keeps read-only tools', () => {
      const schemas = createToolSchemas({ readOnly: true });
      const keys = Object.keys(schemas);

      expect(keys).toContain('execute_sql');
      expect(keys).toContain('search_docs');
      expect(keys).toContain('list_tables');
      expect(keys).toContain('list_organizations');
    });

    test('type excludes write-only tools', () => {
      const schemas = createToolSchemas({ readOnly: true });
      expectTypeOf(schemas).not.toHaveProperty('create_project');
      expectTypeOf(schemas).not.toHaveProperty('deploy_edge_function');
      expectTypeOf(schemas).toHaveProperty('execute_sql');
      expectTypeOf(schemas).toHaveProperty('search_docs');
    });

    test('write tools match readOnlyHint: false tools (excluding readOnlyBehavior: adapt)', () => {
      // Validates that excluded write tools are derived from annotations,
      // and that execute_sql (readOnlyBehavior: 'adapt') is not excluded.
      const derivedWriteTools = Object.entries(supabaseMcpToolSchemas)
        .filter(
          ([, entry]) =>
            entry.annotations.readOnlyHint === false &&
            entry.readOnlyBehavior !== 'adapt'
        )
        .map(([name]) => name)
        .sort();

      const readOnlySchemas = createToolSchemas({ readOnly: true });
      const actuallyExcluded = Object.keys(supabaseMcpToolSchemas)
        .filter((name) => !(name in readOnlySchemas))
        .sort();

      expect(actuallyExcluded).toEqual(derivedWriteTools);
    });
  });

  describe('combined options', () => {
    test('projectScoped + readOnly', () => {
      const schemas = createToolSchemas({
        projectScoped: true,
        readOnly: true,
      });
      const keys = Object.keys(schemas);

      // Account tools excluded (projectScoped)
      expect(keys).not.toContain('list_organizations');

      // Write tools excluded (readOnly)
      expect(keys).not.toContain('apply_migration');
      expect(keys).not.toContain('deploy_edge_function');

      // Read tools with project_id omitted
      expect(keys).toContain('execute_sql');
      const { shape: executeSqlShape } = schemas.execute_sql.inputSchema;
      expect(executeSqlShape).not.toHaveProperty('project_id');
    });

    test('features + projectScoped + readOnly', () => {
      const schemas = createToolSchemas({
        features: ['database', 'docs'],
        projectScoped: true,
        readOnly: true,
      });
      const keys = Object.keys(schemas).sort();

      // Only database read tools + docs
      expect(keys).toEqual([
        'execute_sql',
        'list_extensions',
        'list_migrations',
        'list_tables',
        'search_docs',
      ]);
    });

    test('type narrows correctly with all options', () => {
      const schemas = createToolSchemas({
        features: ['database', 'docs'],
        projectScoped: true,
        readOnly: true,
      });

      // Present
      expectTypeOf(schemas).toHaveProperty('execute_sql');
      expectTypeOf(schemas).toHaveProperty('search_docs');
      expectTypeOf(schemas).toHaveProperty('list_tables');

      // Absent (not in features)
      expectTypeOf(schemas).not.toHaveProperty('list_organizations');
      expectTypeOf(schemas).not.toHaveProperty('deploy_edge_function');

      // Absent (write tool filtered by readOnly)
      expectTypeOf(schemas).not.toHaveProperty('apply_migration');
    });
  });
});
