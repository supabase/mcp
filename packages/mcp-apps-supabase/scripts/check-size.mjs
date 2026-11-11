// Fails the build when the single-file UI bundle grows past the budget.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const FILE = new URL('../dist-ui/api-gateway-report.html', import.meta.url);
const BUDGET_BYTES = 1.2 * 1024 * 1024;

const html = readFileSync(FILE);
const raw = html.length;
const gzip = gzipSync(html, { level: 9 }).length;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(
  `api-gateway-report.html: ${kb(raw)} raw, ${kb(gzip)} gzip (budget ${kb(BUDGET_BYTES)} raw)`
);
if (raw > BUDGET_BYTES) {
  console.error(
    'UI bundle exceeds the size budget. Trim dependencies (recharts is the main cost) before raising it.'
  );
  process.exit(1);
}
