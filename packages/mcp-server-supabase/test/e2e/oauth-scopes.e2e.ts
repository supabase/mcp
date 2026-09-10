import { describe, expect, test } from 'vitest';
import { OAUTH_SCOPES_SUPPORTED } from '../../src/transports/local-http-entry.js';

const HOSTED_DISCOVERY_URL =
  'https://mcp.supabase.com/.well-known/oauth-protected-resource/mcp';

// Type guard (not a tiny wrapper): preserves narrowing for extractScopesSupported below.
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

function extractScopesSupported(body: unknown): string[] {
  if (
    !body ||
    typeof body !== 'object' ||
    !('scopes_supported' in body) ||
    !isStringArray(body.scopes_supported)
  ) {
    throw new Error(
      `Could not verify OAUTH_SCOPES_SUPPORTED: ${HOSTED_DISCOVERY_URL} responded ` +
        `without a "scopes_supported" string array. Got: ${JSON.stringify(body)}`
    );
  }
  return body.scopes_supported;
}

describe('oauth scopes e2e tests', () => {
  // Canary: OAUTH_SCOPES_SUPPORTED in local-http-entry.ts is a static mirror
  // of the hosted server's advertised scopes, not a live lookup (the local
  // --oauth flag needs to work offline / against a mock authorization
  // server in tests). This test is the thing that notices when the mirror
  // goes stale, so a human updates it instead of a developer discovering
  // the gap via a confusing "insufficient scope" error months later.
  test("OAUTH_SCOPES_SUPPORTED mirrors the hosted server's advertised scopes", async () => {
    const response = await fetch(HOSTED_DISCOVERY_URL, {
      signal: AbortSignal.timeout(15_000),
    }).catch((error: unknown) => {
      throw new Error(
        `Could not verify OAUTH_SCOPES_SUPPORTED against the hosted server: ` +
          `GET ${HOSTED_DISCOVERY_URL} did not respond within 15s (${String(error)}).\n` +
          `If this is a transient outage, rerun this job. If the discovery route moved, ` +
          `update HOSTED_DISCOVERY_URL in test/e2e/oauth-scopes.e2e.ts.`
      );
    });
    if (!response.ok) {
      throw new Error(
        `Could not verify OAUTH_SCOPES_SUPPORTED against the hosted server: ` +
          `GET ${HOSTED_DISCOVERY_URL} returned HTTP ${response.status}.\n` +
          `If this is a transient outage, rerun this job. If the discovery route moved, ` +
          `update HOSTED_DISCOVERY_URL in test/e2e/oauth-scopes.e2e.ts.`
      );
    }

    const body = await response.json().catch((error: unknown) => {
      throw new Error(
        `Could not verify OAUTH_SCOPES_SUPPORTED: ${HOSTED_DISCOVERY_URL} returned a ` +
          `non-JSON body (${String(error)}). If this looks like a CDN/WAF interstitial ` +
          `rather than the real endpoint, rerun this job; if the discovery route moved, ` +
          `update HOSTED_DISCOVERY_URL in test/e2e/oauth-scopes.e2e.ts.`
      );
    });
    const hostedScopes = extractScopesSupported(body);

    const local = [...OAUTH_SCOPES_SUPPORTED].sort();
    const hosted = [...hostedScopes].sort();

    const addedUpstream = hosted.filter((scope) => !local.includes(scope));
    const removedUpstream = local.filter((scope) => !hosted.includes(scope));

    if (addedUpstream.length > 0 || removedUpstream.length > 0) {
      const fixLines = [
        `OAUTH_SCOPES_SUPPORTED in packages/mcp-server-supabase/src/transports/local-http-entry.ts ` +
          `has drifted from the hosted server's advertised scopes (${HOSTED_DISCOVERY_URL}).`,
        '',
        'How to fix:',
        '  Edit OAUTH_SCOPES_SUPPORTED in packages/mcp-server-supabase/src/transports/local-http-entry.ts',
        '  so its contents exactly match the hosted list below, then rerun this test.',
        '',
      ];
      if (addedUpstream.length > 0) {
        fixLines.push(
          `  + ADD (hosted has these, local is missing them):`,
          ...addedUpstream.map((scope) => `      ${scope}`)
        );
      }
      if (removedUpstream.length > 0) {
        fixLines.push(
          `  - REMOVE (local has these, hosted no longer does):`,
          ...removedUpstream.map((scope) => `      ${scope}`)
        );
      }
      fixLines.push(
        '',
        `Full hosted list: ${JSON.stringify(hosted)}`,
        `Full local list:  ${JSON.stringify(local)}`
      );
      throw new Error(fixLines.join('\n'));
    }

    expect(local).toEqual(hosted);
  });
});
