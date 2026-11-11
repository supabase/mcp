// Shared between the server (tool results) and the UI bundle. Keep this file
// free of Node-only imports.
import { z } from 'zod/v4';
import { TIME_RANGES } from './constants.js';

export const timeRangeSchema = z.enum(TIME_RANGES);

/** One time bucket, zero-filled across the window. */
export const reportPointSchema = z.object({
  /** ISO-8601 start of the bucket (UTC). */
  timestamp: z.string(),
  total: z.number(),
  errors4xx: z.number(),
  errors5xx: z.number(),
  /** Average origin response time in ms; null when no request had one. */
  avgMs: z.number().nullable(),
  /** 95th percentile origin response time in ms. */
  p95Ms: z.number().nullable(),
});

export const reportRouteSchema = z.object({
  method: z.string(),
  path: z.string(),
  /** Only set for the error-routes table (grouped by status code). */
  statusCode: z.number().nullable(),
  count: z.number(),
  avgMs: z.number().nullable(),
  p95Ms: z.number().nullable(),
});

function panel<T extends z.ZodType>(row: T) {
  return z.object({
    /** Set when this panel's query failed; `rows` is then empty. */
    error: z.string().optional(),
    rows: z.array(row),
  });
}

export const apiGatewayReportSchema = z.object({
  projectId: z.string(),
  timeRange: timeRangeSchema,
  /** ISO-8601 time the report was generated. */
  generatedAt: z.string(),
  window: z.object({
    start: z.string(),
    end: z.string(),
    bucket: z.enum(['minute', 'hour']),
  }),
  summary: z.object({
    /** Fields are null when the query that feeds them failed. */
    totalRequests: z.number().nullable(),
    errors4xx: z.number().nullable(),
    errors5xx: z.number().nullable(),
    /** Percentage (0-100) of requests with a 4xx or 5xx status. */
    errorRatePercent: z.number().nullable(),
    avgMs: z.number().nullable(),
    p95Ms: z.number().nullable(),
  }),
  timeseries: panel(reportPointSchema),
  topRoutes: panel(reportRouteSchema),
  topErrorRoutes: panel(reportRouteSchema),
  slowestRoutes: panel(reportRouteSchema),
});

export type ReportPoint = z.infer<typeof reportPointSchema>;
export type ReportRoute = z.infer<typeof reportRouteSchema>;
export type ApiGatewayReport = z.infer<typeof apiGatewayReportSchema>;
