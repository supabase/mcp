import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fetchSkillsManifest } from './manifest.js';
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

describe('fetchSkillsManifest', () => {
  it('downloads, verifies, and unpacks every skill into addressable files with digests', async () => {
    const tarball = await buildTarball({
      'SKILL.md': '---\nname: alpha\n---\n\nHello',
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

    const manifest = await fetchSkillsManifest({ fetchImpl });

    expect(manifest.skills).toHaveLength(1);
    const skill = manifest.skills[0]!;
    expect(skill.uri).toBe('skill://alpha/SKILL.md');
    expect(skill.frontmatter).toEqual({
      name: 'alpha',
      description: 'The alpha skill.',
    });

    const paths = skill.files.map((file) => file.path).sort();
    expect(paths).toEqual(['SKILL.md', 'references/foo.md']);

    const skillMd = skill.files.find((file) => file.path === 'SKILL.md')!;
    expect(skillMd.uri).toBe('skill://alpha/SKILL.md');
    expect(skillMd.digest).toBe(
      `sha256:${createHash('sha256').update('---\nname: alpha\n---\n\nHello').digest('hex')}`
    );
    expect(skillMd.size).toBe(
      Buffer.byteLength('---\nname: alpha\n---\n\nHello')
    );

    const reference = skill.files.find(
      (file) => file.path === 'references/foo.md'
    )!;
    expect(reference.uri).toBe('skill://alpha/references/foo.md');
    expect(reference.mimeType).toBe('text/markdown');
  });

  it('rejects a skill archive whose bytes do not match the published digest', async () => {
    const tarball = await buildTarball({ 'SKILL.md': 'hello' });

    const fetchImpl = createFakeFetch({
      [INDEX_URL]: () =>
        jsonResponse({
          skills: [
            {
              name: 'alpha',
              type: 'archive',
              description: 'The alpha skill.',
              url: 'https://example.com/alpha.tar.gz',
              digest: `sha256:${'0'.repeat(64)}`,
            },
          ],
        }),
      'https://example.com/alpha.tar.gz': () => binaryResponse(tarball),
    });

    await expect(fetchSkillsManifest({ fetchImpl })).rejects.toThrow(
      /digest mismatch/
    );
  });

  it('rejects an archive with no SKILL.md file', async () => {
    const tarball = await buildTarball({ 'references/foo.md': '# Foo' });
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

    await expect(fetchSkillsManifest({ fetchImpl })).rejects.toThrow(
      /does not contain a SKILL\.md/
    );
  });

  it('rejects a malformed discovery index', async () => {
    const fetchImpl = createFakeFetch({
      [INDEX_URL]: () => jsonResponse({ skills: [{ name: 'alpha' }] }),
    });

    await expect(fetchSkillsManifest({ fetchImpl })).rejects.toThrow();
  });

  it('surfaces a non-OK response fetching the index', async () => {
    const fetchImpl = createFakeFetch({
      [INDEX_URL]: () => new Response('nope', { status: 500 }),
    });

    await expect(fetchSkillsManifest({ fetchImpl })).rejects.toThrow(
      /failed to fetch/
    );
  });
});
