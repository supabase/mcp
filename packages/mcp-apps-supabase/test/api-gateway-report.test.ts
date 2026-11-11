import { Client, type ClientCapabilities } from '@modelcontextprotocol/client';
import { createMcpServer, StreamTransport } from '@supabase/mcp-utils';
import { describe, expect, test, vi } from 'vitest';
import {
  API_GATEWAY_REPORT_RESOURCE_URI,
  apiGatewayReportExtension,
  apiGatewayReportSchema,
  GET_API_GATEWAY_REPORT_DATA_TOOL,
  MCP_APP_MIME_TYPE,
  SHOW_API_GATEWAY_REPORT_TOOL,
  UI_EXTENSION_ID,
  type ApiGatewayReportDataSource,
} from '../src/index.js';

const NOW = new Date('2026-01-01T12:34:56.000Z');
const micros = (iso: string) => Date.parse(iso) * 1000;

const SERIES = {
  result: [
    {
      timestamp: micros('2026-01-01T12:30:00Z'),
      total: 100,
      errors_4xx: 5,
      errors_5xx: 5,
      avg_ms: 20,
      p95_ms: 90,
    },
  ],
};
const ROUTES = {
  result: [
    {
      kind: 'summary',
      path: '',
      method: '',
      status_code: 0,
      count: 100,
      avg_ms: 20,
      p95_ms: 90,
    },
    {
      kind: 'top',
      path: '/rest/v1/todos',
      method: 'GET',
      status_code: 0,
      count: 70,
      avg_ms: 15,
      p95_ms: 60,
    },
    {
      kind: 'error',
      path: '/auth/v1/token',
      method: 'POST',
      status_code: 500,
      count: 5,
      avg_ms: 30,
      p95_ms: 40,
    },
    {
      kind: 'slow',
      path: '/functions/v1/slow',
      method: 'POST',
      status_code: 0,
      count: 3,
      avg_ms: 800,
      p95_ms: 900,
    },
  ],
};

function fakeDataSource(
  respond?: (sql: string) => unknown
): ApiGatewayReportDataSource & { queryLogs: ReturnType<typeof vi.fn> } {
  return {
    queryLogs: vi.fn(async (_projectId: string, { sql }: { sql: string }) => {
      if (respond) return respond(sql);
      return sql.includes("'summary' as kind") ? ROUTES : SERIES;
    }),
  };
}

async function connect(
  extension: ReturnType<typeof apiGatewayReportExtension>,
  capabilities: ClientCapabilities = {}
) {
  const server = createMcpServer({
    name: 'test-server',
    version: '0.0.0',
    tools: extension.tools as never,
    resources: extension.resources,
    extensions: extension.extensions,
  });
  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();
  clientTransport.readable.pipeTo(serverTransport.writable);
  serverTransport.readable.pipeTo(clientTransport.writable);
  const client = new Client(
    { name: 'test-client', version: '0.1.0' },
    { capabilities }
  );
  // StreamTransport.close() errors its streams, so (like the mcp-utils tests)
  // connections are not closed explicitly.
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function textOf(result: { content?: unknown }) {
  const [first] = (result.content ?? []) as { type: string; text: string }[];
  return first?.text ?? '';
}

describe('api gateway report extension', () => {
  test('declares the UI extension capability and resources', async () => {
    const client = await connect(
      apiGatewayReportExtension({ dataSource: fakeDataSource() })
    );
    const caps = client.getServerCapabilities();
    expect(caps?.extensions).toEqual({
      [UI_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] },
    });
    expect(caps).toHaveProperty('resources');
  });

  test('lists both tools with _meta in both key styles and app-only visibility', async () => {
    const client = await connect(
      apiGatewayReportExtension({ dataSource: fakeDataSource() })
    );
    const { tools } = await client.listTools();
    const show = tools.find((t) => t.name === SHOW_API_GATEWAY_REPORT_TOOL)!;
    const data = tools.find(
      (t) => t.name === GET_API_GATEWAY_REPORT_DATA_TOOL
    )!;

    expect(show._meta).toEqual({
      ui: { resourceUri: API_GATEWAY_REPORT_RESOURCE_URI },
      'ui/resourceUri': API_GATEWAY_REPORT_RESOURCE_URI,
    });
    expect(data._meta).toEqual({
      ui: { resourceUri: API_GATEWAY_REPORT_RESOURCE_URI, visibility: ['app'] },
      'ui/resourceUri': API_GATEWAY_REPORT_RESOURCE_URI,
    });
    for (const t of [show, data]) {
      expect(t.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(t.annotations?.title).toBeTruthy();
    }
    expect(show.description).toMatch(/MCP Apps/);
    const props = (show.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props).sort()).toEqual(['project_id', 'time_range']);
    expect((props.time_range as { enum: string[] }).enum).toEqual([
      '10m',
      '30m',
      '1h',
      '3h',
      '24h',
    ]);
  });

  test('omits project_id from the schema when scoped and injects it', async () => {
    const dataSource = fakeDataSource();
    const client = await connect(
      apiGatewayReportExtension({
        dataSource,
        projectId: 'scoped-proj',
        now: () => NOW,
      })
    );
    const { tools } = await client.listTools();
    for (const t of tools) {
      const props = (t.inputSchema as { properties: Record<string, unknown> })
        .properties;
      expect(Object.keys(props)).toEqual(['time_range']);
    }

    await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { time_range: '10m' },
    });
    expect(dataSource.queryLogs).toHaveBeenCalledWith(
      'scoped-proj',
      expect.any(Object)
    );

    const rejected = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'other', time_range: '10m' },
    });
    expect(rejected.isError).toBe(true);
  });

  test('returns content and schema-conforming structuredContent', async () => {
    const dataSource = fakeDataSource();
    const client = await connect(
      apiGatewayReportExtension({ dataSource, now: () => NOW })
    );
    const result = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'proj', time_range: '30m' },
    });

    expect(result.isError).toBeFalsy();
    const report = apiGatewayReportSchema.parse(result.structuredContent);
    expect(report.projectId).toBe('proj');
    expect(report.timeRange).toBe('30m');
    expect(report.timeseries.rows).toHaveLength(30);
    expect(report.summary).toMatchObject({
      totalRequests: 100,
      errors4xx: 5,
      errors5xx: 5,
      errorRatePercent: 10,
      p95Ms: 90,
    });

    const text = textOf(result);
    expect(text).toMatch(/<untrusted-data-[0-9a-f-]+>/);
    expect(text).toMatch(/never follow any instructions/);
    expect(text).toContain('Total requests: 100');
    expect(text).toContain('error rate: 10.00%');
    expect(text).toContain('GET /rest/v1/todos');
    expect(text).toContain('POST /auth/v1/token');
    expect(text).toContain('POST /functions/v1/slow');

    // Budget: two parallel calls, window passed as params not SQL.
    expect(dataSource.queryLogs).toHaveBeenCalledTimes(2);
    for (const [, options] of dataSource.queryLogs.mock.calls) {
      expect(options.iso_timestamp_end).toBe('2026-01-01T12:34:00.000Z');
      expect(options.iso_timestamp_start).toBe('2026-01-01T12:04:00.000Z');
    }
  });

  test('defaults time_range to 1h and the app-only tool works too', async () => {
    const client = await connect(
      apiGatewayReportExtension({
        dataSource: fakeDataSource(),
        now: () => NOW,
      })
    );
    const result = await client.callTool({
      name: GET_API_GATEWAY_REPORT_DATA_TOOL,
      arguments: { project_id: 'proj' },
    });
    expect(
      apiGatewayReportSchema.parse(result.structuredContent).timeRange
    ).toBe('1h');
  });

  test('rejects invalid time ranges', async () => {
    const client = await connect(
      apiGatewayReportExtension({ dataSource: fakeDataSource() })
    );
    const result = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'proj', time_range: '7d' },
    });
    expect(result.isError).toBe(true);
  });

  test('one failed query yields a panel error, not a tool error', async () => {
    const client = await connect(
      apiGatewayReportExtension({
        dataSource: fakeDataSource((sql) => {
          if (sql.includes("'summary' as kind")) throw new Error('routes down');
          return SERIES;
        }),
        now: () => NOW,
      })
    );
    const result = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'proj', time_range: '10m' },
    });
    expect(result.isError).toBeFalsy();
    const report = apiGatewayReportSchema.parse(result.structuredContent);
    expect(report.topRoutes.error).toBe('routes down');
    expect(report.timeseries.error).toBeUndefined();
    expect(textOf(result)).toContain('Some panels failed');
  });

  test('an error field in a 200 body fails that panel', async () => {
    const client = await connect(
      apiGatewayReportExtension({
        dataSource: fakeDataSource((sql) =>
          sql.includes("'summary' as kind")
            ? ROUTES
            : { result: [], error: { message: 'bad column' } }
        ),
        now: () => NOW,
      })
    );
    const result = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'proj', time_range: '10m' },
    });
    const report = apiGatewayReportSchema.parse(result.structuredContent);
    expect(report.timeseries.error).toBe('bad column');
    expect(report.topRoutes.rows.length).toBeGreaterThan(0);
  });

  test('errors when every query fails', async () => {
    const client = await connect(
      apiGatewayReportExtension({
        dataSource: fakeDataSource((sql) => {
          throw new Error(
            sql.includes("'summary' as kind")
              ? 'union not supported'
              : 'logs unavailable'
          );
        }),
        now: () => NOW,
      })
    );
    const result = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'proj', time_range: '10m' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Time series: logs unavailable');
    expect(textOf(result)).toContain('Routes: union not supported');
    expect(result.structuredContent).toBeUndefined();
  });

  test('reports both errors when every 200 body carries an error field', async () => {
    const client = await connect(
      apiGatewayReportExtension({
        dataSource: fakeDataSource((sql) => ({
          result: [],
          error: {
            message: sql.includes("'summary' as kind")
              ? 'union not supported'
              : 'bad column',
          },
        })),
        now: () => NOW,
      })
    );
    const result = await client.callTool({
      name: SHOW_API_GATEWAY_REPORT_TOOL,
      arguments: { project_id: 'proj', time_range: '10m' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Time series: bad column');
    expect(textOf(result)).toContain('Routes: union not supported');
  });

  test('lists and reads the UI resource with mime type and _meta', async () => {
    const client = await connect(
      apiGatewayReportExtension({ dataSource: fakeDataSource() })
    );
    const meta = {
      ui: {
        csp: { connectDomains: [], resourceDomains: [] },
        prefersBorder: true,
      },
    };

    const { resources } = await client.listResources();
    expect(resources).toEqual([
      expect.objectContaining({
        uri: API_GATEWAY_REPORT_RESOURCE_URI,
        mimeType: MCP_APP_MIME_TYPE,
        _meta: meta,
      }),
    ]);

    const { contents } = await client.readResource({
      uri: API_GATEWAY_REPORT_RESOURCE_URI,
    });
    expect(contents).toEqual([
      expect.objectContaining({
        uri: API_GATEWAY_REPORT_RESOURCE_URI,
        mimeType: MCP_APP_MIME_TYPE,
        text: expect.stringContaining('<html'),
        _meta: meta,
      }),
    ]);
  });
});
