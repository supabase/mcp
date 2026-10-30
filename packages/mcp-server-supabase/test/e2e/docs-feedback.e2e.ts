/// <reference types="../extensions.d.ts" />

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMCPClient } from '@ai-sdk/mcp';
import { StreamTransport } from '@supabase/mcp-utils';
import { generateText, stepCountIs } from 'ai';
import { source } from 'common-tags';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createSupabaseMcpServer } from '../../src/index.js';
import { instructions } from '../../src/server.js';
import { contentApiMockSchema, MCP_CLIENT_NAME } from '../mocks.js';
import { getTestModel } from './utils.js';

type DocsPage = { title: string; href: string; content: string };

const DELETE_TOKEN = '5d6d3b3e-4b2f-4a52-9b77-0f0e6a4f6a11';

const OUTDATED_GUIDE: DocsPage = {
  title: 'Get the signed-in user on the server',
  href: 'https://supabase.com/docs/guides/auth/server-side/get-user',
  content: source`
    # Get the signed-in user on the server

    In supabase-js v2, read the access token from the request, then call the auth API:

    const { user } = await supabase.auth.api.getUser(accessToken)
  `,
};

const CURRENT_REFERENCE: DocsPage = {
  title: 'JavaScript: auth.getUser()',
  href: 'https://supabase.com/docs/reference/javascript/auth-getuser',
  content: source`
    # auth.getUser()

    Gets the user for an access token (JWT).

    const { data: { user } } = await supabase.auth.getUser(jwt)
  `,
};

// Real clients put server instructions in the system prompt, but @ai-sdk/mcp drops them
const SYSTEM_PROMPT = `You are a coding agent. Check the Supabase docs with your tools before you write code.\n\n${instructions}`;

const TASK =
  'Write a TypeScript function for a server route that uses supabase-js v2 and returns the user for an access token. Reply with the code.';

const docsServers: Server[] = [];

afterEach(() => {
  for (const server of docsServers.splice(0)) server.close();
});

// A local docs API serves the same pages on every run, instead of the live docs
async function setupDocsFeedback(pages: DocsPage[]) {
  const docsServer = createServer((request, response) => {
    const query =
      new URL(request.url ?? '/', 'http://localhost').searchParams.get(
        'query'
      ) ?? '';
    const data = query.includes('searchDocs')
      ? { searchDocs: { nodes: pages, edges: pages.map((node) => ({ node })) } }
      : { schema: contentApiMockSchema };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data }));
  });
  docsServers.push(docsServer);
  await new Promise<void>((resolve) =>
    docsServer.listen(0, '127.0.0.1', resolve)
  );
  const { port } = docsServer.address() as AddressInfo;

  const submit = vi.fn().mockResolvedValue({ deleteToken: DELETE_TOKEN });
  const server = createSupabaseMcpServer({
    platform: { feedback: { submit, delete: vi.fn() } },
    features: ['docs', 'feedback'],
    contentApiUrl: `http://127.0.0.1:${port}/graphql`,
  });

  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();
  clientTransport.readable.pipeTo(serverTransport.writable);
  serverTransport.readable.pipeTo(clientTransport.writable);
  await server.connect(serverTransport);

  const client = await createMCPClient({
    name: MCP_CLIENT_NAME,
    transport: clientTransport,
  });

  return { tools: await client.tools(), submit };
}

describe('docs feedback e2e tests', () => {
  test('sends a docs friction log on request after working around an outdated page', async () => {
    const model = getTestModel();
    const { tools, submit } = await setupDocsFeedback([
      OUTDATED_GUIDE,
      CURRENT_REFERENCE,
    ]);
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: TASK },
    ];

    const firstTurn = await generateText({
      model,
      tools,
      messages,
      stopWhen: stepCountIs(8),
    });

    const firstToolCalls = firstTurn.steps.flatMap((step) => step.toolCalls);
    expect(firstToolCalls.some((call) => call.toolName === 'search_docs')).toBe(
      true
    );
    await expect(firstTurn.text).toMatchCriteria(
      'Uses auth.getUser() from supabase-js v2, not auth.api.getUser()'
    );
    expect(submit).not.toHaveBeenCalled();

    // Agents do not send docs feedback without a request, so the second turn asks for a friction log
    const secondTurn = await generateText({
      model,
      tools,
      messages: [
        ...messages,
        ...firstTurn.response.messages,
        {
          role: 'user' as const,
          content:
            'Write a friction log of any problems you had with the Supabase docs in this session, and send it as docs feedback.',
        },
      ],
      stopWhen: stepCountIs(4),
    });

    const guideTarget = submit.mock.calls
      .flatMap(([report]) => report.targets ?? [])
      .find((target: { url: string }) => target.url === OUTDATED_GUIDE.href);
    expect(guideTarget).toBeDefined();
    expect(OUTDATED_GUIDE.content).toContain(guideTarget.quote.trim());
    expect(secondTurn.text).toContain(DELETE_TOKEN);
  }, 120_000);

  test('does not offer docs feedback when the docs are correct', async () => {
    const model = getTestModel();
    const { tools, submit } = await setupDocsFeedback([CURRENT_REFERENCE]);

    const { text } = await generateText({
      model,
      tools,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: TASK },
      ],
      stopWhen: stepCountIs(8),
    });

    await expect(text).toMatchCriteria(
      'Uses auth.getUser() and does not offer to send feedback to Supabase'
    );
    expect(submit).not.toHaveBeenCalled();
  }, 120_000);
});
