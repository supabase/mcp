import {
  App as McpApp,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from '@modelcontextprotocol/ext-apps';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GET_API_GATEWAY_REPORT_DATA_TOOL,
  TIME_RANGES,
  type TimeRange,
} from '../src/constants.js';
import {
  apiGatewayReportSchema,
  type ApiGatewayReport,
  type ReportPoint,
} from '../src/schema.js';
import {
  BarsChart,
  errorSeries,
  latencySeries,
  LinesChart,
  requestSeries,
} from './charts.js';
import {
  formatPercentage,
  millisecondFormatter,
  numberFormatter,
} from './format.js';
import { RouteTable } from './RouteTable.js';

const app = new McpApp(
  { name: 'supabase-api-gateway-report', version: '0.1.0' },
  {},
  { autoResize: true }
);

function applyHostContext(ctx?: McpUiHostContext) {
  if (!ctx) return;
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
}

function parseReport(structured: unknown): ApiGatewayReport | string {
  const parsed = apiGatewayReportSchema.safeParse(structured);
  return parsed.success
    ? parsed.data
    : 'The report data was not in the expected format.';
}

function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (item && item.type === 'text' && typeof item.text === 'string') {
      return item.text;
    }
  }
  return undefined;
}

export function App() {
  const [report, setReport] = useState<ApiGatewayReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<TimeRange>('1h');
  // Only forwarded when the model-facing call had it; project-scoped servers
  // omit `project_id` from the tool schema.
  const projectIdArg = useRef<string | undefined>(undefined);
  const requestId = useRef(0);

  useEffect(() => {
    app.ontoolinput = (params) => {
      const id = params.arguments?.project_id;
      projectIdArg.current = typeof id === 'string' ? id : undefined;
    };
    app.ontoolresult = (result) => {
      requestId.current++;
      setLoading(false);
      if (result.isError) {
        setError(textOf(result.content) ?? 'The report could not be loaded.');
        return;
      }
      const parsed = parseReport(result.structuredContent);
      if (typeof parsed === 'string') {
        setError(parsed);
      } else {
        setError(null);
        setReport(parsed);
        setRange(parsed.timeRange);
      }
    };
    app.onhostcontextchanged = (ctx) => applyHostContext(ctx);
    app
      .connect()
      .then(() => applyHostContext(app.getHostContext()))
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : 'Failed to connect to host')
      );
  }, []);

  const load = useCallback(async (next: TimeRange) => {
    const id = ++requestId.current;
    setRange(next);
    setLoading(true);
    try {
      const result = await app.callServerTool({
        name: GET_API_GATEWAY_REPORT_DATA_TOOL,
        arguments: {
          ...(projectIdArg.current !== undefined && {
            project_id: projectIdArg.current,
          }),
          time_range: next,
        },
      });
      if (id !== requestId.current) return; // a newer request superseded this one
      if (result.isError) {
        setError(textOf(result.content) ?? 'The report could not be loaded.');
        return;
      }
      const parsed = parseReport(result.structuredContent);
      if (typeof parsed === 'string') {
        setError(parsed);
      } else {
        setError(null);
        setReport(parsed);
      }
    } catch (e) {
      if (id !== requestId.current) return;
      setError(
        e instanceof Error ? e.message : 'The report could not be loaded.'
      );
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, []);

  return (
    <div className="report">
      <Header report={report} range={range} loading={loading} onRange={load} />
      {error && <div className="banner error">{error}</div>}
      {report ? <Panels report={report} /> : !error && <Loading />}
    </div>
  );
}

function Loading() {
  return <div className="placeholder">Waiting for report data...</div>;
}

function Header({
  report,
  range,
  loading,
  onRange,
}: {
  report: ApiGatewayReport | null;
  range: TimeRange;
  loading: boolean;
  onRange: (range: TimeRange) => void;
}) {
  const s = report?.summary;
  return (
    <div className="header">
      <div>
        <h1 className="title">API gateway report</h1>
        <div className="stats">
          <Stat
            label="Requests"
            value={
              s?.totalRequests == null ? '-' : numberFormatter(s.totalRequests)
            }
          />
          <Stat
            label="Error rate"
            value={
              s?.errorRatePercent == null
                ? '-'
                : formatPercentage(s.errorRatePercent)
            }
          />
          <Stat
            label="p95 latency"
            value={s?.p95Ms == null ? '-' : millisecondFormatter(s.p95Ms)}
          />
        </div>
      </div>
      <div className="range" role="group" aria-label="Time range">
        {TIME_RANGES.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={r === range}
            disabled={loading}
            onClick={() => r !== range && onRange(r)}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function Panel({
  title,
  error,
  empty,
  children,
}: {
  title: string;
  error?: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {error ? (
        <div className="placeholder error">Failed to load: {error}</div>
      ) : empty ? (
        <div className="placeholder">No requests in this window</div>
      ) : (
        children
      )}
    </section>
  );
}

function Panels({ report }: { report: ApiGatewayReport }) {
  const data: ReportPoint[] = report.timeseries.rows;
  const empty = data.every((p) => p.total === 0);
  const series = report.timeseries;
  const routeEmpty = report.summary.totalRequests === 0;
  return (
    <>
      <div className="grid">
        <Panel title="Total requests" error={series.error} empty={empty}>
          <BarsChart data={data} series={requestSeries} />
        </Panel>
        <Panel
          title="Errors by status class"
          error={series.error}
          empty={empty}
        >
          <BarsChart data={data} series={errorSeries} stacked />
        </Panel>
        <Panel title="Response time" error={series.error} empty={empty}>
          <LinesChart data={data} series={latencySeries} />
        </Panel>
      </div>
      <div className="grid">
        <Panel
          title="Top routes"
          error={report.topRoutes.error}
          empty={routeEmpty}
        >
          <RouteTable rows={report.topRoutes.rows} columns={['count', 'avg']} />
        </Panel>
        <Panel
          title="Top error routes"
          error={report.topErrorRoutes.error}
          empty={routeEmpty}
        >
          <RouteTable
            rows={report.topErrorRoutes.rows}
            columns={['status', 'count']}
          />
        </Panel>
        <Panel
          title="Slowest routes"
          error={report.slowestRoutes.error}
          empty={routeEmpty}
        >
          <RouteTable
            rows={report.slowestRoutes.rows}
            columns={['avg', 'p95', 'count']}
          />
        </Panel>
      </div>
    </>
  );
}
