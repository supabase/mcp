import { getSkill, listSkills } from '@modelcontextprotocol/client/ext/skills';
import { skillsCapabilityOf } from '@modelcontextprotocol/core/ext/skills';
import { Client } from '@modelcontextprotocol/client';
import { StreamTransport } from '@supabase/mcp-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupabaseMcpServer } from '../server.js';
import { buildTarball, createFakeFetch, sha256 } from './test-helpers.js';

const INDEX_URL = 'https://supabase.com/.well-known/agent-skills';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function binaryResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), { status: 200 });
}

async function setup() {
  const tarball = await buildTarball({
    'SKILL.md': '---\nname: alpha\ndescription: The alpha skill.\n---\n\nHello',
    'references/foo.md': '# Foo',
  });
  const digest = sha256(tarball);

  const fetchImpl = createFakeFetch({
    [INDEX_URL]: () =>
      jsonResponse({
        skills: [
          {
            name: 'alpha',
            type: 'archive',
            description: 'The alpha skill.',
            url: 'https://example.com/alpha.tar.gz',
            digest,
          },
        ],
      }),
    'https://example.com/alpha.tar.gz': () => binaryResponse(tarball),
  });

  const clientTransport = new StreamTransport();
  const serverTransport = new StreamTransport();
  clientTransport.readable.pipeTo(serverTransport.writable);
  serverTransport.readable.pipeTo(clientTransport.writable);

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} }
  );

  const server = createSupabaseMcpServer({
    platform: {},
    skills: { fetchImpl },
  });

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return { client, server };
}

describe('skills over MCP', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('advertises the skills extension alongside resources', async () => {
    const { client } = await setup();
    const capability = skillsCapabilityOf(client.getServerCapabilities());
    expect(capability).toBeDefined();
    expect(client.getServerCapabilities()?.resources).toBeDefined();
  });

  it('lists the skill published at the discovery index', async () => {
    const { client } = await setup();
    const { skills } = await listSkills(client);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      uri: 'skill://alpha/SKILL.md',
      frontmatter: { name: 'alpha', description: 'The alpha skill.' },
    });
    expect(skills[0]?.resources).not.toBe('dynamic');
  });

  it('resolves a single skill by uri, including files not in the frontmatter', async () => {
    const { client } = await setup();
    const { skill } = await getSkill(client, {
      uri: 'skill://alpha/SKILL.md',
    });

    const uris = Array.isArray(skill.resources)
      ? skill.resources.map((resource) => resource.uri).sort()
      : [];
    expect(uris).toEqual([
      'skill://alpha/SKILL.md',
      'skill://alpha/references/foo.md',
    ]);
  });

  it('rejects an unknown skill uri with -32602', async () => {
    const { client } = await setup();
    await expect(
      getSkill(client, { uri: 'skill://does-not-exist/SKILL.md' })
    ).rejects.toThrow();
  });

  it('serves the real file bytes over resources/read, matching the published digest', async () => {
    const { client } = await setup();
    const { skill } = await getSkill(client, {
      uri: 'skill://alpha/SKILL.md',
    });
    const entries = Array.isArray(skill.resources) ? skill.resources : [];
    const skillMdEntry = entries.find(
      (entry) => entry.uri === 'skill://alpha/SKILL.md'
    );
    expect(skillMdEntry).toBeDefined();

    const { contents } = await client.readResource({
      uri: 'skill://alpha/SKILL.md',
    });
    const [content] = contents;
    if (!content || !('text' in content)) {
      throw new Error('expected a text resource content');
    }
    expect(content.text).toContain('Hello');

    const { createHash } = await import('node:crypto');
    const actualDigest = `sha256:${createHash('sha256').update(content.text).digest('hex')}`;
    expect(actualDigest).toBe(skillMdEntry?.digest);
  });
});
