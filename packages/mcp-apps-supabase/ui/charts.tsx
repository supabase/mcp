import type { ReactNode } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ReportPoint } from '../src/schema.js';
import {
  compactNumberFormatter,
  millisecondFormatter,
  numberFormatter,
  timestampFormatter,
  timeTickFormatter,
} from './format.js';

// Fixed height: autoResize otherwise sends a stream of resize messages.
export const CHART_HEIGHT = 160;

type Series = {
  key: keyof ReportPoint;
  label: string;
  color: string;
  format: (value: number) => string;
};

function ChartTooltip({
  active,
  payload,
  label,
  series,
}: {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown }[];
  label?: unknown;
  series: Series[];
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tooltip">
      <div>{timestampFormatter(String(label))}</div>
      {series.map((s) => {
        const entry = payload.find((p) => p.dataKey === s.key);
        const value = entry?.value;
        return (
          <div key={s.key}>
            <span className="swatch" style={{ background: s.color }} />
            {s.label}: {typeof value === 'number' ? s.format(value) : 'n/a'}
          </div>
        );
      })}
    </div>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key}>
          <span className="swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

const axisProps = {
  tick: { fill: 'var(--fg-muted)', fontSize: 11 },
  axisLine: false,
  tickLine: false,
} as const;

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="chart">
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        {children as never}
      </ResponsiveContainer>
    </div>
  );
}

export function BarsChart({
  data,
  series,
  stacked = false,
}: {
  data: ReportPoint[];
  series: Series[];
  stacked?: boolean;
}) {
  return (
    <>
      <Legend series={series} />
      <Frame>
        <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="timestamp"
            tickFormatter={timeTickFormatter}
            minTickGap={32}
            {...axisProps}
          />
          <YAxis
            width={40}
            allowDecimals={false}
            tickFormatter={compactNumberFormatter}
            {...axisProps}
          />
          <Tooltip
            cursor={{ fill: 'var(--grid)' }}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={props.payload}
                label={props.label}
                series={series}
              />
            )}
          />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              fill={s.color}
              stackId={stacked ? 'stack' : undefined}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </Frame>
    </>
  );
}

export function LinesChart({
  data,
  series,
}: {
  data: ReportPoint[];
  series: Series[];
}) {
  return (
    <>
      <Legend series={series} />
      <Frame>
        <LineChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
        >
          <CartesianGrid stroke="var(--grid)" vertical={false} />
          <XAxis
            dataKey="timestamp"
            tickFormatter={timeTickFormatter}
            minTickGap={32}
            {...axisProps}
          />
          <YAxis
            width={52}
            tickFormatter={(v: number) => millisecondFormatter(v)}
            {...axisProps}
          />
          <Tooltip
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={props.payload}
                label={props.label}
                series={series}
              />
            )}
          />
          {series.map((s) => (
            <Line
              key={s.key}
              dataKey={s.key}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </Frame>
    </>
  );
}

export const requestSeries: Series[] = [
  {
    key: 'total',
    label: 'Requests',
    color: 'var(--chart-requests)',
    format: (v) => numberFormatter(v),
  },
];

export const errorSeries: Series[] = [
  {
    key: 'errors4xx',
    label: '4xx',
    color: 'var(--chart-4xx)',
    format: (v) => numberFormatter(v),
  },
  {
    key: 'errors5xx',
    label: '5xx',
    color: 'var(--chart-5xx)',
    format: (v) => numberFormatter(v),
  },
];

export const latencySeries: Series[] = [
  {
    key: 'avgMs',
    label: 'Avg',
    color: 'var(--chart-avg)',
    format: (v) => millisecondFormatter(v),
  },
  {
    key: 'p95Ms',
    label: 'p95',
    color: 'var(--chart-p95)',
    format: (v) => millisecondFormatter(v),
  },
];
