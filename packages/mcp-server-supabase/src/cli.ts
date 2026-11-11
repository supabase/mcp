#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import packageJson from '../package.json' with { type: 'json' };
import { createSupabaseApiPlatform } from './platform/api-platform.js';
import { createSupabaseMcpServer } from './server.js';
import {
  type AppAssets,
  type AppsOptions,
  APPS_BUILD_COMMAND,
  assertValidAssetsUrl,
} from './tools/apps/resources.js';
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
      ['apps-dir']: cliAppsDir,
      ['apps-url']: cliAppsUrl,
      ['apps-inline']: appsInline,
      ['apps-all-clients']: appsAllClients,
      ['app-link']: appLink,
    },
  } = parseArgs({
    options: {
      ['apps-dir']: {
        type: 'string',
      },
      ['apps-url']: {
        type: 'string',
      },
      ['apps-inline']: {
        type: 'boolean',
        default: false,
      },
      ['apps-all-clients']: {
        type: 'boolean',
        default: false,
      },
      ['app-link']: {
        type: 'string',
      },
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

  const features = cliFeatures ? parseList(cliFeatures) : undefined;
  const appsDir = cliAppsDir ?? process.env.SUPABASE_MCP_APPS_DIR;
  const appsUrl = cliAppsUrl ?? process.env.SUPABASE_MCP_APPS_URL;
  if (appsDir && appsUrl) {
    console.error('Pass either --apps-dir or --apps-url, not both.');
    process.exitCode = 1;
    return;
  }
  if (appsUrl) {
    try {
      assertValidAssetsUrl(appsUrl);
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
      return;
    }
  }
  const appsAssets: AppAssets | undefined = appsDir
    ? { dir: resolve(appsDir) }
    : appsUrl
      ? { url: appsUrl, inline: appsInline }
      : undefined;
  const apps: AppsOptions | undefined = appsAssets && {
    assets: appsAssets,
    clients: appsAllClients ? 'all' : 'capable',
    appLinkBase: appLink,
  };
  // Surfaces are read on every request, so a missing build is not fatal here.
  if (
    appsAssets &&
    'dir' in appsAssets &&
    !existsSync(join(appsAssets.dir, 'projects.js'))
  ) {
    console.error(
      `No MCP Apps build in ${appsAssets.dir} yet. Run \`${APPS_BUILD_COMMAND}\` in the Supabase monorepo.`
    );
  }

  const contentApiUrl =
    cliContentApiUrl ?? process.env.SUPABASE_CONTENT_API_URL;

  if (http) {
    try {
      const entry = await startLocalHttpEntry({
        port: Number(cliPort),
        apiUrl,
        contentApiUrl,
        secretUrlTemplate,
        apps,
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
        apps,
      }),
    { onerror: console.error }
  );
}

main().catch(console.error);
