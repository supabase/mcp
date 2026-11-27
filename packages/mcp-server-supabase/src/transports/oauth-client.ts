import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  auth,
  type OAuthClientProvider,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

// Same directory the Supabase CLI keeps its login in.
export const STORE_PATH = join(
  process.env.SUPABASE_HOME ?? join(homedir(), '.supabase'),
  'mcp-oauth.json'
);
const REDIRECT_URL = 'http://127.0.0.1:3112/callback';

type Stored = {
  client?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  codeVerifier?: string;
  expiresAt?: number;
};

async function read(): Promise<Stored> {
  try {
    return JSON.parse(await readFile(STORE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function write(patch: Stored) {
  await mkdir(dirname(STORE_PATH), { recursive: true });
  await writeFile(STORE_PATH, JSON.stringify({ ...(await read()), ...patch }), {
    mode: 0o600,
  });
}

const provider: OAuthClientProvider = {
  redirectUrl: REDIRECT_URL,
  clientMetadata: {
    client_name: 'Supabase MCP local dev server',
    redirect_uris: [REDIRECT_URL],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'client_secret_post',
  },
  clientInformation: async () => (await read()).client,
  saveClientInformation: (client) => write({ client }),
  tokens: async () => (await read()).tokens,
  saveTokens: (tokens) =>
    write({
      tokens,
      expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    }),
  saveCodeVerifier: (codeVerifier) => write({ codeVerifier }),
  codeVerifier: async () => {
    const { codeVerifier } = await read();
    if (!codeVerifier) throw new Error('No pending sign-in');
    return codeVerifier;
  },
  invalidateCredentials: (scope) =>
    write({
      ...(scope === 'all' || scope === 'client' ? { client: undefined } : {}),
      ...(scope === 'all' || scope === 'tokens' ? { tokens: undefined } : {}),
    }),
  redirectToAuthorization: (url) => {
    console.error(`Sign in to Supabase in your browser:\n${url}`);
    const openers: Partial<Record<NodeJS.Platform, string>> = {
      darwin: 'open',
      win32: 'start',
    };
    const opener = openers[process.platform] ?? 'xdg-open';
    spawn(opener, [url.href], { stdio: 'ignore', detached: true }).unref();
  },
};

async function waitForCode() {
  const server = createServer((req, res) => {
    const code = new URL(req.url ?? '/', REDIRECT_URL).searchParams.get('code');
    res.end(code ? 'Signed in. You can close this tab.' : 'Missing code.');
    if (code) server.emit('code', code);
  });
  server.listen(3112, '127.0.0.1');
  await once(server, 'listening');
  const [code] = await once(server, 'code');
  server.close();
  return String(code);
}

/** Signs in if needed and returns a token getter that refreshes on expiry. */
export async function login(serverUrl: string) {
  if ((await auth(provider, { serverUrl })) === 'REDIRECT') {
    await auth(provider, { serverUrl, authorizationCode: await waitForCode() });
  }
  // Refresh tokens are single use, so concurrent callers share one refresh.
  let refreshing: Promise<unknown> | undefined;
  return async () => {
    let { tokens, expiresAt = 0 } = await read();
    if (!tokens || expiresAt < Date.now() + 60_000) {
      refreshing ??= auth(provider, { serverUrl }).finally(() => {
        refreshing = undefined;
      });
      await refreshing;
      ({ tokens } = await read());
    }
    if (!tokens) throw new Error('Not signed in');
    return tokens.access_token;
  };
}
