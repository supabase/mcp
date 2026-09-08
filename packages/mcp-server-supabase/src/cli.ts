#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import packageJson from '../package.json' with { type: 'json' };
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import { createSupabaseMcpServer } from './server.js';
import { startLocalHttpEntry } from './transports/local-http-entry.js';
import { parseList } from './transports/util.js';
import { parseFeatureGroups } from './util.js';

const { version } = packageJson;

async function main() {
  const {
    values: {
      ['access-token']: cliAccessToken,
      ['project-ref']: projectId,
      ['read-only']: readOnly,
      ['api-url']: apiUrl,
      ['content-api-url']: cliContentApiUrl,
      ['version']: showVersion,
      ['features']: cliFeatures,
      ['http']: http,
      ['port']: cliPort,
      ['oauth']: oauth,
    },
  } = parseArgs({
    options: {
      ['access-token']: {
        type: 'string',
      },
      ['project-ref']: {
        type: 'string',
      },
      ['read-only']: {
        type: 'boolean',
        default: false,
      },
      ['api-url']: {
        type: 'string',
      },
      ['content-api-url']: {
        type: 'string',
      },
      ['version']: {
        type: 'boolean',
      },
      ['features']: {
        type: 'string',
      },
      ['http']: {
        type: 'boolean',
        default: false,
      },
      ['port']: {
        type: 'string',
        default: '3111',
      },
      ['oauth']: {
        type: 'boolean',
        default: false,
      },
    },
  });

  if (showVersion) {
    console.log(version);
    process.exit(0);
  }

  const features = cliFeatures ? parseList(cliFeatures) : undefined;

  const contentApiUrl =
    cliContentApiUrl ?? process.env.SUPABASE_CONTENT_API_URL;

  if (http) {
    const oauthAuthorizationServer = oauth
      ? new URL(apiUrl ?? 'https://api.supabase.com')
      : undefined;
    const entry = await startLocalHttpEntry({
      port: Number(cliPort),
      apiUrl,
      contentApiUrl,
      oauthAuthorizationServer,
    });
    console.error(`Supabase MCP server listening on ${entry.url}`);
    if (oauthAuthorizationServer) {
      console.error(
        'Your MCP client signs in with Supabase OAuth in the browser on connect.'
      );
      console.error(
        'Note: signing in against api.supabase.com will currently fail (400) until platform widens its OAuth resource validation for loopback URLs; see CONTRIBUTING.md.'
      );
    }
    return;
  }

  const accessToken = cliAccessToken ?? process.env.SUPABASE_ACCESS_TOKEN;

  if (!accessToken) {
    console.error(
      'Please provide a personal access token (PAT) with the --access-token flag or set the SUPABASE_ACCESS_TOKEN environment variable'
    );
    process.exit(1);
  }

  const platform = createSupabaseApiPlatform({
    accessToken,
    apiUrl,
  });

  if (features) {
    parseFeatureGroups(platform, features);
  }

  // `serveStdio` reports transport startup and out-of-band wire errors only
  // through `onerror`, and swallows them otherwise, so this keeps the stderr
  // output the previous awaited `server.connect()` got from `main().catch`.
  serveStdio(
    () =>
      createSupabaseMcpServer({
        platform,
        projectId,
        readOnly,
        features,
        contentApiUrl,
      }),
    { onerror: console.error }
  );
}

main().catch(console.error);
