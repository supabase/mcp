import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const directory = import.meta.dirname;
const generatedAt = '2026-09-24T00:00:00.000Z';

export function buildEvidence() {
  const production = {
    calls: 298_336_657,
    clientCoveragePct: 100,
    errorCount: 20_424_344,
    errorRatePct: 6.85,
    explicitSessionCoveragePct: 47.81,
    explicitSessions: 114_386_871,
    identifiedUserCoveragePct: 100,
    identifiedUsers: 714_309,
    latencyMs: { p50: 788, p95: 3_168 },
    outputChars: { p50: 845, p95: 25_139 },
  };

  const intentClusters = [
    { goal: 'Query and inspect data', sessions: 744, sharePct: 31, completionPct: 78 },
    { goal: 'Project operations', sessions: 504, sharePct: 21, completionPct: 91 },
    { goal: 'Schema and migration', sessions: 408, sharePct: 17, completionPct: 76 },
    { goal: 'Reliability and diagnostics', sessions: 336, sharePct: 14, completionPct: 69 },
    { goal: 'Edge and deploy', sessions: 240, sharePct: 10, completionPct: 83 },
    { goal: 'Account and discovery', sessions: 168, sharePct: 7, completionPct: 88 },
  ];

  const cohorts = [
    { cohort: 'Builders', sessions: 840, sharePct: 35, completionPct: 82, repeatToolPct: 18 },
    { cohort: 'Operators', sessions: 600, sharePct: 25, completionPct: 75, repeatToolPct: 24 },
    { cohort: 'Debuggers', sessions: 456, sharePct: 19, completionPct: 67, repeatToolPct: 36 },
    { cohort: 'Release teams', sessions: 336, sharePct: 14, completionPct: 79, repeatToolPct: 21 },
    { cohort: 'Explorers', sessions: 168, sharePct: 7, completionPct: 61, repeatToolPct: 42 },
  ];

  const recommendations = [
    {
      id: 'R1',
      priority: 'P0',
      action: 'Reduce execute_sql failures',
      owner: 'MCP reliability',
      evidence: '243.6M production calls at 7.68% errors',
      success: 'Error rate below 6.85% baseline without lower call volume',
    },
    {
      id: 'R2',
      priority: 'P0',
      action: 'Add Backups and PITR coverage',
      owner: 'Capability parity',
      evidence: 'Top synthetic gap: 168 demand sessions, 96 blocked',
      success: 'Blocked rate below 25% in the workflow model',
    },
    {
      id: 'R3',
      priority: 'P0',
      action: 'Cap or page oversized outputs',
      owner: 'MCP platform',
      evidence: 'generate_typescript_types p95 is 673,196 characters',
      success: 'p95 output below 100,000 characters with retrieval path intact',
    },
    {
      id: 'R4',
      priority: 'P1',
      action: 'Investigate Cursor 1.0.0 compatibility',
      owner: 'Client compatibility',
      evidence: 'Observed error rate rose 1.50 percentage points',
      success: 'Matched-window rate returns to prior baseline',
    },
    {
      id: 'R5',
      priority: 'P1',
      action: 'Raise explicit session-handle coverage',
      owner: 'Telemetry',
      evidence: 'Production field coverage is 47.81%',
      success: 'Coverage above 80% with client and user dimensions intact',
    },
  ];

  const evidence = {
    metadata: {
      generatedAt,
      title: 'MCP product analytics',
      sources: [
        {
          id: 'production',
          label: 'Production aggregate',
          dataset: 'mcp.logs.prod',
          windowStart: '2026-08-27T00:00:00.000Z',
          windowEnd: '2026-09-24T00:00:00.000Z',
          grain: 'Aggregate metrics only',
        },
        {
          id: 'synthetic',
          label: 'Synthetic workflow model',
          sessions: 2_400,
          generation: 'Fixed aggregate scenario set',
        },
        {
          id: 'validated',
          label: 'Controlled session validation',
          calls: 15,
          explicitSessions: 8,
        },
      ],
      privacy: {
        aggregateOnly: true,
        rawArgumentsIncluded: false,
        rawAuthIncluded: false,
        rawErrorsIncluded: false,
        rawIdentifiersIncluded: false,
        rawResponsesIncluded: false,
        rawSqlIncluded: false,
      },
    },
    executive: {
      production,
      synthetic: {
        sessions: 2_400,
        completedSessions: 1_764,
        completionPct: 73.5,
        recoveredSessions: 336,
        initialFailureSessions: 512,
        recoveryPct: 65.6,
      },
    },
    intentClusters,
    cohorts,
    workflows: {
      funnel: [
        { stage: 'Session started', sessions: 2_400, conversionPct: 100 },
        { stage: 'Tool path found', sessions: 2_184, conversionPct: 91 },
        { stage: 'Action selected', sessions: 1_932, conversionPct: 80.5 },
        { stage: 'Goal completed', sessions: 1_764, conversionPct: 73.5 },
      ],
      recovery: {
        initialFailureSessions: 512,
        recoveredSessions: 336,
        abandonedSessions: 176,
        recoveryPct: 65.6,
      },
      loops: [
        { path: 'execute_sql → execute_sql', sessions: 192, signal: 'Retry loop' },
        { path: 'get_advisors → get_logs', sessions: 132, signal: 'Healthy recovery' },
        { path: 'list_projects → get_project', sessions: 118, signal: 'Healthy handoff' },
        { path: 'get_more_tools → get_more_tools', sessions: 74, signal: 'Dead-end loop' },
      ],
    },
    missingCapabilities: [
      { capability: 'Backups and PITR', demandSessions: 168, blockedSessions: 96, recoveryPct: 22 },
      { capability: 'Billing and cost detail', demandSessions: 132, blockedSessions: 75, recoveryPct: 30 },
      { capability: 'Auth user administration', demandSessions: 111, blockedSessions: 62, recoveryPct: 28 },
      { capability: 'Storage object operations', demandSessions: 96, blockedSessions: 44, recoveryPct: 46 },
      { capability: 'Realtime inspection', demandSessions: 72, blockedSessions: 31, recoveryPct: 51 },
      { capability: 'Project network settings', demandSessions: 60, blockedSessions: 28, recoveryPct: 38 },
    ],
    reliability: {
      production,
      tools: [
        { tool: 'execute_sql', calls: 243_604_751, errorRatePct: 7.68 },
        { tool: 'apply_migration', calls: 11_949_736, errorRatePct: 5.33 },
        { tool: 'get_advisors', calls: 5_659_285, errorRatePct: 1.02 },
        { tool: 'list_projects', calls: 5_419_368, errorRatePct: 0.32 },
        { tool: 'get_edge_function', calls: 5_326_104, errorRatePct: 1.44 },
      ],
      outputHotspots: [
        { tool: 'generate_typescript_types', p50Chars: 70_604, p95Chars: 673_196 },
        { tool: 'get_advisors', p50Chars: 14_689, p95Chars: 328_354 },
        { tool: 'get_edge_function', p50Chars: 13_273, p95Chars: 289_187 },
        { tool: 'list_tables', p50Chars: 6_339, p95Chars: 209_909 },
      ],
    },
    continuity: {
      productionExplicitSessionCoveragePct: 47.81,
      validatedExplicitSessions: 8,
      validatedCalls: 15,
      validatedMergeCount: 0,
      validatedSplitCount: 0,
      fallbackFixture: { estimatedMerges: 27, estimatedSplits: 1 },
      agentContinuity: [
        { mode: 'Same agent and client', sessions: 1_368, completionPct: 81 },
        { mode: 'Agent changed, client held', sessions: 552, completionPct: 70 },
        { mode: 'Client changed', sessions: 288, completionPct: 63 },
        { mode: 'Fallback session estimate', sessions: 192, completionPct: 54 },
      ],
    },
    clientVersions: [
      {
        client: 'Cursor',
        version: '1.0.0',
        priorCalls: 2_998_455,
        currentCalls: 4_312_935,
        priorErrorRatePct: 9.66,
        currentErrorRatePct: 11.15,
        deltaPercentagePoints: 1.5,
        interpretation: 'Observed association; not causal',
      },
    ],
    telemetry: {
      productionCoverage: [
        { field: 'Client name', coveragePct: 100 },
        { field: 'Client version', coveragePct: 100 },
        { field: 'Identified user', coveragePct: 100 },
        { field: 'Explicit session', coveragePct: 47.81 },
      ],
      privacyControls: [
        'Aggregate production metrics only',
        'Synthetic intent and workflow labels',
        'No raw arguments, responses, SQL, identifiers, auth values, or error text',
        'Deterministic local generation and privacy checks',
      ],
      knownLimits: [
        'Synthetic workflows show product hypotheses, not measured production intent.',
        'Client and version comparisons are observational.',
        'Inferred sessions and funnels depend on a fallback heuristic.',
      ],
    },
    evalBacklog: [
      { priority: 'P0', scenario: 'execute_sql failure recovery', evidence: '18.7M estimated production failures', contract: 'Useful next action without exposing server detail' },
      { priority: 'P0', scenario: 'Backups and PITR intent', evidence: '96 blocked synthetic sessions', contract: 'Route to a supported safe workflow' },
      { priority: 'P1', scenario: 'Oversized type output', evidence: '673,196-character production p95', contract: 'Bound output and preserve retrieval' },
      { priority: 'P1', scenario: 'Cross-client session resume', evidence: '47.81% explicit-session coverage', contract: 'Keep explicit handle continuity' },
      { priority: 'P1', scenario: 'Cursor 1.0.0 compatibility', evidence: '+1.50 percentage-point error rate', contract: 'Match prior-window reliability' },
      { priority: 'P2', scenario: 'Tool discovery dead end', evidence: '74 synthetic repeat loops', contract: 'Return a useful next step' },
    ],
    recommendations,
  } as const;

  assert.equal(intentClusters.reduce((sum, row) => sum + row.sessions, 0), 2_400);
  assert.equal(cohorts.reduce((sum, row) => sum + row.sessions, 0), 2_400);
  assert.equal(evidence.workflows.funnel.at(-1)?.sessions, evidence.executive.synthetic.completedSessions);
  assert.equal(
    evidence.workflows.recovery.recoveredSessions + evidence.workflows.recovery.abandonedSessions,
    evidence.workflows.recovery.initialFailureSessions,
  );
  assert.equal(recommendations[1].action, 'Add Backups and PITR coverage');
  return evidence;
}


async function main() {
  const evidence = buildEvidence();
  await writeFile(`${directory}/evidence.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: 'evidence.json', productionCalls: evidence.executive.production.calls, syntheticSessions: evidence.executive.synthetic.sessions }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
