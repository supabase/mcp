import { z } from 'zod/v4';

const observedAt = z.iso.datetime().nullable().meta({
  description:
    'Time the API retrieved this information. This timestamp does not indicate when data was measured or last synchronized.',
});
const availability = z.enum(['available', 'unavailable', 'not_provisioned']);
const tableState = z.enum([
  'queued',
  'copying_table',
  'copied_table',
  'following_wal',
  'error',
]);
const lagSchema = z
  .object({
    active: z.boolean(),
    wal_status: z
      .enum(['reserved', 'extended', 'unreserved', 'lost', 'unknown'])
      .nullable(),
    write_lag_ms: z.number().nonnegative().nullable(),
    flush_lag_ms: z.number().nonnegative().nullable(),
    feedback_age_ms: z.number().nonnegative().nullable(),
  })
  .meta({
    description:
      'Postgres replication feedback. Null means unknown. Feedback age measures time since the last response and does not establish how current query results are.',
  });

export const warehouseContextSchema = z.object({
  project_ref: z.string().regex(/^[a-z]{20}$/),
  observed_at: z.iso.datetime(),
  status: z
    .enum([
      'not_provisioned',
      'disabled',
      'disabling',
      'starting',
      'ready',
      'stopped',
      'stopping',
      'degraded',
      'unavailable',
    ])
    .meta({
      description:
        'Warehouse setup and replication status. Ready means the Warehouse connection is configured and tables are replicating ongoing changes. It does not guarantee that a query will succeed.',
    }),
  lifecycle: z
    .object({
      status: z.enum(['disabling', 'disabled', 'deletion_failed']),
      updated_at: z.iso.datetime(),
    })
    .nullable(),
  compute: z
    .object({
      status: availability,
      region: z.string().nullable(),
      routing_status: z
        .enum(['pending', 'ready', 'error', 'removed'])
        .nullable(),
      observed_at: observedAt,
    })
    .meta({
      description:
        'Configured Warehouse compute and region, which may differ from the source database region. Live availability and capacity are not reported.',
    }),
  pipeline: z
    .object({
      id: z.string().min(1),
      status: z.enum([
        'stopped',
        'starting',
        'started',
        'stopping',
        'unknown',
        'failed',
        'unavailable',
      ]),
      observed_at: observedAt,
    })
    .nullable(),
  replication: z.object({
    status: z.enum([
      'available',
      'unavailable',
      'not_provisioned',
      'not_started',
      'stopped',
    ]),
    observed_at: observedAt,
    apply_lag: lagSchema.nullable(),
  }),
  tables: z.object({
    status: availability,
    observed_at: observedAt,
    items: z.array(
      z.object({
        id: z.number().int().positive(),
        schema: z.string(),
        name: z.string(),
        replication_state: tableState.nullable(),
        sync_lag: lagSchema.nullable(),
      })
    ),
  }),
  capabilities: z
    .object({
      context: z.boolean(),
      workload_metrics: z.boolean(),
      query_explain: z.boolean(),
      table_layout_read: z.boolean(),
      table_layout_update: z.boolean(),
    })
    .meta({
      description:
        'Diagnostic operations supported by this API. Each operation still requires the appropriate project permissions.',
    }),
});

export type WarehouseContext = z.infer<typeof warehouseContextSchema>;

export type WarehouseOperations = {
  getContext(projectId: string): Promise<WarehouseContext>;
};

export type WarehousePaths = {
  '/platform/warehouse/{ref}/context': {
    get: {
      parameters: { path: { ref: string } };
      responses: {
        200: { content: { 'application/json': WarehouseContext } };
        default: { content: { 'application/json': { message: string } } };
      };
    };
  };
};
