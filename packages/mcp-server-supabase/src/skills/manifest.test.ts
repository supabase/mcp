import { createHash } from 'node:crypto';
import { MAX_SKILL_TOTAL_BYTES } from '@modelcontextprotocol/core/ext/skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  describe('a skill exceeding the practical per-skill size limit', () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
        // silence expected warning output during this test
      });
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    // SEP-2640 says servers SHOULD NOT exceed this size, but explicitly does
    // not forbid it: hosts MUST support skills up to the limit and MAY
    // support larger ones. So an oversized skill must be skipped with a
    // warning, never thrown as a hard error, and must not prevent other,
    // properly-sized skills from being served.
    it('is skipped with a logged warning, without rejecting the whole manifest', async () => {
      const oversizedTarball = await buildTarball({
        'SKILL.md': '---\nname: huge\n---\n\nHi',
        'references/big.bin': 'x'.repeat(MAX_SKILL_TOTAL_BYTES + 1),
      });
      const oversizedDigest = sha256(oversizedTarball);

      const okTarball = await buildTarball({
        'SKILL.md': '---\nname: alpha\n---\n\nHello',
      });
      const okDigest = sha256(okTarball);

      const fetchImpl = createFakeFetch({
        [INDEX_URL]: () =>
          jsonResponse({
            skills: [
              {
                name: 'huge',
                type: 'archive',
                description: 'The huge skill.',
                url: 'https://example.com/huge.tar.gz',
                digest: oversizedDigest,
              },
              {
                name: 'alpha',
                type: 'archive',
                description: 'The alpha skill.',
                url: 'https://example.com/alpha.tar.gz',
                digest: okDigest,
              },
            ],
          }),
        'https://example.com/huge.tar.gz': () =>
          binaryResponse(oversizedTarball),
        'https://example.com/alpha.tar.gz': () => binaryResponse(okTarball),
      });

      const manifest = await fetchSkillsManifest({ fetchImpl });

      expect(manifest.skills.map((skill) => skill.frontmatter.name)).toEqual([
        'alpha',
      ]);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipping skill "huge"')
      );
    });
  });
});
