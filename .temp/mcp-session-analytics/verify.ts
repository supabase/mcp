import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildEvidence } from './run.ts';
import { renderReport } from './render.ts';

const directory = import.meta.dirname;
const evidencePath = resolve(directory, 'evidence.json');
const reportPath = resolve(directory, 'report.html');
const readmePath = resolve(directory, 'README.md');
const smokePath = resolve(directory, 'smoke.ts');
const verificationPath = resolve(directory, 'verification.json');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const firstEvidence = buildEvidence();
const secondEvidence = buildEvidence();
const firstEvidenceText = `${JSON.stringify(firstEvidence, null, 2)}\n`;
const secondEvidenceText = `${JSON.stringify(secondEvidence, null, 2)}\n`;
assert.equal(firstEvidenceText, secondEvidenceText, 'Evidence generation must be deterministic');

const firstReport = await renderReport(firstEvidence);
const secondReport = await renderReport(secondEvidence);
assert.equal(firstReport, secondReport, 'Report rendering must be deterministic');
assert.equal(await readFile(evidencePath, 'utf8'), firstEvidenceText, 'Generated evidence must match the checked model');
assert.equal(await readFile(reportPath, 'utf8'), firstReport, 'Generated report must match the checked render');
const [readme, smoke] = await Promise.all([readFile(readmePath, 'utf8'), readFile(smokePath, 'utf8')]);
assert(readme.includes('pnpm dev:http'), 'Quickstart must start the local HTTP MCP server');
assert(readme.includes('run smoke:http'), 'Quickstart must include the local smoke command');
assert(smoke.includes("endpoint.searchParams.set('read_only', 'true')"), 'Smoke client must force read-only mode');
assert(smoke.includes("['127.0.0.1', 'localhost', '::1']"), 'Smoke client must stay on loopback');

const requiredSections = [
  'overview',
  'intents',
  'workflows',
  'capabilities',
  'reliability',
  'sessions',
  'versions',
  'telemetry',
  'evals',
  'actions',
];
for (const section of requiredSections) {
  assert(firstReport.includes(`id="${section}"`), `Missing dashboard section: ${section}`);
}

const requiredSessionCopy = [
  'https://docs.agentcat.com/sdk/stateless-servers',
  'groups events without a session ID by identified user, AI client, and a 30-minute inactivity window',
  'This is an approximation, not ground truth',
  'the heuristic can merge them',
  'Treat inferred session counts and funnels as estimates',
  'Explicit validated session handles remain the higher-confidence signal',
];
for (const text of requiredSessionCopy) {
  assert(firstReport.includes(text), `Missing session disclaimer text: ${text}`);
}

assert(firstReport.includes('rel="icon" href="data:image/svg+xml'), 'Report must embed a favicon');
assert(!firstReport.includes('src="http'), 'Report must not load remote scripts or images');
assert(!firstReport.includes('rel="stylesheet"'), 'Report must not load remote stylesheets');
assert(firstReport.includes('Production aggregate'), 'Report must label production aggregates');
assert(firstReport.includes('Synthetic model'), 'Report must label synthetic findings');
assert(!/\b(?:experiment|proof of concept|poc)\b/i.test(firstReport), 'Report must read as a product dashboard');

const serializedArtifacts = `${firstEvidenceText}\n${firstReport}`;
const forbiddenPatterns = [
  { label: 'authorization value', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/i },
  { label: 'JWT-shaped value', pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/ },
  { label: 'Supabase secret', pattern: /\b(?:sb_secret_|sbp_)[A-Za-z0-9_-]+/i },
  { label: 'fixture identifier', pattern: /\b(?:actor|project|org)-fixture-[A-Za-z0-9_-]+/i },
  { label: 'raw identifier key', pattern: /"(?:userId|user_id|projectRef|project_ref|organizationId|organization_id|authToken|accessToken)"\s*:/i },
  { label: 'raw payload key', pattern: /"(?:args|arguments|response|responseText|rawError|errorMessage|sql)"\s*:/i },
  { label: 'stack trace', pattern: /\b(?:at\s+\w+\s+\([^\n]+:\d+:\d+\)|stack trace)\b/i },
];
for (const { label, pattern } of forbiddenPatterns) {
  assert(!pattern.test(serializedArtifacts), `Privacy scan found ${label}`);
}

const verification = {
  checkedAt: '2026-09-24T00:00:00.000Z',
  status: 'pass',
  deterministic: {
    evidence: sha256(firstEvidenceText) === sha256(secondEvidenceText),
    report: sha256(firstReport) === sha256(secondReport),
  },
  artifacts: {
    evidence: { path: 'evidence.json', bytes: Buffer.byteLength(firstEvidenceText), sha256: sha256(firstEvidenceText) },
    report: { path: 'report.html', bytes: Buffer.byteLength(firstReport), sha256: sha256(firstReport) },
  },
  checks: [
    'All requested dashboard sections are present',
    'Production and synthetic sources are labeled',
    'Session approximation disclaimer is visible and linked',
    'Inline favicon is present',
    'No remote scripts, images, or stylesheets',
    'Local HTTP quickstart and loopback-only smoke check are present',
    'Privacy scan found no raw payloads, identifiers, auth values, SQL, or stack traces',
  ],
};

await writeFile(verificationPath, `${JSON.stringify(verification, null, 2)}\n`);
console.log(JSON.stringify(verification));
