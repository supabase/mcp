import {
  EXTENSION_ID as APPS_EXTENSION_ID,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import type { Client } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import {
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
} from '@modelcontextprotocol/core/ext/skills';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod/v4';
import { createServerHarness } from '../../test/server-harness.js';
import { LIST_PROJECTS_UI_URI } from '../resources/app-resources.js';
import { buildTarball, createFakeFetch, sha256 } from './test-helpers.js';

const INDEX_URL = 'https://supabase.com/.well-known/agent-skills';
const SKILL_MD =
  '---\nname: alpha\ndescription: The alpha skill.\n---\n\nHello';
const SKILL_URI = 'skill://alpha/SKILL.md';
const FOO_URI = 'skill://alpha/references/foo.md';

const APPS_CLIENT_CAPABILITIES = {
  extensions: {
    [APPS_EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] },
  },
};

const harness = createServerHarness();

beforeEach(() => harness.reset());
afterEach(() => harness.close());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function binaryResponse(body: Buffer): Response {
  return new Response(new Uint8Array(body), { status: 200 });
}

async function skillsOptions() {
  const tarball = await buildTarball({
    'SKILL.md': SKILL_MD,
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

  return { fetchImpl };
}

/** The raw wire result, without the SDK's era-specific result schemas. */
function rawRequest(client: Client, method: string, params = {}) {
  return client.request({ method, params }, z.looseObject({}));
}

const eras = [
  {
    era: '2025-11-25',
    connect: async () =>
      (await harness.setup({ skills: await skillsOptions() })).client,
    cacheFields: {},
  },
  {
    era: '2026-07-28',
    connect: async () =>
      (await harness.setupModern({ skills: await skillsOptions() })).client,
    cacheFields: { ttlMs: 0, cacheScope: 'private' },
  },
] as const;

describe.each(eras)(
  'skills over MCP ($era)',
  ({ era, connect, cacheFields }) => {
    it('advertises the skills extension alongside resources', async () => {
      const client = await connect();
      expect(client.getNegotiatedProtocolVersion()).toBe(era);
      expect(new SkillsClient(client).supported).toBe(true);
      expect(client.getServerCapabilities()?.resources).toBeDefined();
    });

    it('lists the skill published at the discovery index', async () => {
      const { skills, invalid } = await new SkillsClient(
        await connect()
      ).list();

      expect(invalid).toEqual([]);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        uri: SKILL_URI,
        frontmatter: { name: 'alpha', description: 'The alpha skill.' },
      });
      expect(skills[0]?.resources).not.toBe('dynamic');
    });

    it('resolves a single skill by uri, including files not in the frontmatter', async () => {
      const { skill } = await new SkillsClient(await connect()).get(SKILL_URI);

      const uris = Array.isArray(skill.resources)
        ? skill.resources.map((resource) => resource.uri).sort()
        : [];
      expect(uris).toEqual([SKILL_URI, FOO_URI]);
    });

    it('rejects an unknown skill uri with -32602', async () => {
      const skills = new SkillsClient(await connect());
      await expect(
        skills.get('skill://does-not-exist/SKILL.md')
      ).rejects.toMatchObject({ code: -32602 });
    });

    it('serves file bytes over resources/read that verify against the skill entry', async () => {
      const skills = new SkillsClient(await connect());
      const { skill } = await skills.get(SKILL_URI);

      // `read` checks size, digest and (for SKILL.md) frontmatter, and throws
      // a SkillVerificationError on any mismatch.
      const manifest = await skills.read(skill);
      expect(manifest).toMatchObject({
        uri: SKILL_URI,
        verified: true,
        frontmatter: { name: 'alpha', description: 'The alpha skill.' },
      });
      expect(manifest.text).toBe(SKILL_MD);

      const reference = await skills.read(skill, 'references/foo.md');
      expect(reference).toMatchObject({
        uri: FOO_URI,
        verified: true,
        text: '# Foo',
      });
    });

    it('carries cache fields only on 2026-07-28', async () => {
      const client = await connect();

      for (const result of [
        await rawRequest(client, SKILLS_LIST_METHOD),
        await rawRequest(client, SKILLS_GET_METHOD, { uri: SKILL_URI }),
      ]) {
        const carried = Object.fromEntries(
          Object.entries(result).filter(
            ([key]) => key === 'ttlMs' || key === 'cacheScope'
          )
        );
        expect(carried).toEqual(cacheFields);
      }
    });
  }
);

describe('skills alongside MCP Apps (2026-07-28)', () => {
  const cases = [
    { apps: false, skills: false },
    { apps: true, skills: false },
    { apps: false, skills: true },
    { apps: true, skills: true },
  ];

  it.each(cases)(
    'apps $apps, skills $skills: both extensions and both resource sets survive',
    async ({ apps, skills }) => {
      const { client } = await harness.setupModern({
        experimentalApps: apps,
        skills: skills ? await skillsOptions() : undefined,
        clientCapabilities: APPS_CLIENT_CAPABILITIES,
      });

      const capabilities = client.getServerCapabilities();
      const extensions = Object.keys(capabilities?.extensions ?? {}).sort();
      expect(extensions).toEqual(
        [
          ...(apps ? [APPS_EXTENSION_ID] : []),
          ...(skills ? [SKILLS_EXTENSION_ID] : []),
        ].sort()
      );

      if (!apps && !skills) {
        expect(capabilities?.resources).toBeUndefined();
        return;
      }

      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris.includes(LIST_PROJECTS_UI_URI)).toBe(apps);
      expect(uris.includes(SKILL_URI)).toBe(skills);
      expect(uris.includes(FOO_URI)).toBe(skills);
    }
  );
});
