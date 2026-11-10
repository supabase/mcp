#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import packageJson from '../package.json' with { type: 'json' };
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import { loadExperimentalExtensions } from './experimental.js';
import { createSupabaseMcpServer } from './server.js';
import { startLocalHttpEntry } from './transports/local-http-entry.js';
import { parseList } from './transports/util.js';
import { dashboardUrlForApiUrl, parseFeatureGroups } from './util.js';

const { version } = packageJson;

async function main() {
  const {
    values: {
      ['access-token']: cliAccessToken,
      ['project-ref']: projectId,
      ['read-only']: readOnly,
      ['api-url']: apiUrl,
      ['content-api-url']: cliContentApiUrl,
      ['secret-url-template']: secretUrlTemplate,
      ['version']: showVersion,
      ['features']: cliFeatures,
      ['http']: http,
      ['port']: cliPort,
      ['experimental-apps']: experimentalApps,
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
      ['secret-url-template']: {
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
      ['experimental-apps']: {
        type: 'boolean',
        default: false,
      },
    },
  });

  if (showVersion) {
    console.log(version);
    process.exit(0);
  }

  if (secretUrlTemplate !== undefined && !http) {
    console.error('--secret-url-template requires --http.');
    process.exitCode = 1;
    return;
  }

  if (http && experimentalApps) {
    console.error(
      'Warning: --experimental-apps is ignored with --http. Use the ?experimental_apps=true query parameter instead.'
    );
  }

  const features = cliFeatures ? parseList(cliFeatures) : undefined;

  const contentApiUrl =
    cliContentApiUrl ?? process.env.SUPABASE_CONTENT_API_URL;

  if (http) {
    try {
      const entry = await startLocalHttpEntry({
        port: Number(cliPort),
        apiUrl,
        contentApiUrl,
        secretUrlTemplate,
      });
      console.error(`Supabase MCP server listening on ${entry.url}`);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
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

  const extensions = await loadExperimentalExtensions({
    apps: experimentalApps,
  });

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
        dashboardUrl: dashboardUrlForApiUrl(apiUrl),
        extensions,
      }),
    { onerror: console.error }
  );
}

main().catch(console.error);
