// Module hooks for running sources and test mocks directly with tsx (see
// scripts/dev-mock-server.ts): `.sql` imports load as text, matching tsup's
// text loader, and the mocks' `vitest` assertions become no-ops outside a test
// run.
import { register } from 'node:module';

const vitestShim = `data:text/javascript,${encodeURIComponent(
  'const chain = new Proxy(() => chain, { get: () => chain, apply: () => chain }); export const expect = () => chain;'
)}`;

register(
  `data:text/javascript,${encodeURIComponent(`
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier === 'vitest') return { url: ${JSON.stringify(vitestShim)}, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (!url.endsWith('.sql')) return next(url, context);
  const text = await readFile(fileURLToPath(url), 'utf8');
  return { format: 'module', shortCircuit: true, source: 'export default ' + JSON.stringify(text) };
}
`)}`
);
