import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type {
  SkillFrontmatter,
  SkillResourceEntry,
} from '@modelcontextprotocol/core/ext/skills';
import {
  MAX_SKILL_TOTAL_BYTES,
  SKILL_MANIFEST_FILENAME,
  SKILL_URI_SCHEME,
} from '@modelcontextprotocol/core/ext/skills';
import { extract as extractTar } from 'tar-stream';
import { z } from 'zod/v4';
import { AGENT_SKILLS_INDEX_URL } from './constants.js';

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const skillIndexEntrySchema = z.object({
  name: z.string(),
  type: z.literal('archive'),
  description: z.string(),
  url: z.string(),
  digest: z.string().regex(SHA256_DIGEST_PATTERN),
});

const skillsIndexSchema = z.object({
  skills: z.array(skillIndexEntrySchema),
});

export type SkillIndexEntry = z.infer<typeof skillIndexEntrySchema>;

/**
 * One file unpacked from a skill's archive, with the material needed both to
 * serve it over `resources/read` and to list it in a `skills/get` manifest.
 */
export type SkillFile = {
  /** Resource URI, e.g. `skill://supabase/references/foo.md`. */
  uri: string;
  /** Path relative to the archive root, e.g. `references/foo.md`. */
  path: string;
  bytes: Uint8Array;
  digest: string;
  size: number;
  mimeType: string;
};

/** A single fetched-and-unpacked Supabase agent skill. */
export type SupabaseSkill = {
  /** The `SKILL.md` resource URI — the key `skills/get` resolves against. */
  uri: string;
  frontmatter: SkillFrontmatter;
  /** Every file in the unpacked archive, including `SKILL.md` itself. */
  files: SkillFile[];
};

export type SkillsManifest = {
  skills: SupabaseSkill[];
  fetchedAt: number;
};

export type FetchSkillsManifestOptions = {
  /** Discovery index URL. Defaults to {@linkcode AGENT_SKILLS_INDEX_URL}. */
  indexUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  userAgent?: string;
};

/** Builds a `skill://` resource entry list from a skill's unpacked files. */
export function toSkillResourceEntries(
  skill: SupabaseSkill
): SkillResourceEntry[] {
  return skill.files.map((file) => ({
    uri: file.uri,
    digest: file.digest,
    size: file.size,
  }));
}

/** Whether a file's bytes should be served as UTF-8 `text` rather than a base64 `blob`. */
export function isTextMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/yaml'
  );
}

function guessMimeType(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.yaml') || path.endsWith('.yml'))
    return 'application/yaml';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'text/plain';
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function fetchJson(
  url: string,
  fetchImpl: typeof fetch,
  userAgent?: string
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: userAgent ? { 'User-Agent': userAgent } : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return response.json();
}

async function downloadTarball(
  entry: SkillIndexEntry,
  fetchImpl: typeof fetch,
  userAgent?: string
): Promise<Buffer> {
  const response = await fetchImpl(entry.url, {
    headers: userAgent ? { 'User-Agent': userAgent } : undefined,
  });
  if (!response.ok) {
    throw new Error(
      `failed to download skill archive "${entry.name}": ${response.status} ${response.statusText}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const actualDigest = sha256(buffer);
  if (actualDigest !== entry.digest) {
    throw new Error(
      `digest mismatch for skill archive "${entry.name}": expected ${entry.digest}, got ${actualDigest}`
    );
  }

  return buffer;
}

/** Gunzips and untars an archive's bytes into a path -> file-bytes map. */
function unpackTarball(buffer: Buffer): Promise<Map<string, Uint8Array>> {
  const gunzipped = gunzipSync(buffer);
  const files = new Map<string, Uint8Array>();

  return new Promise((resolve, reject) => {
    const tarExtract = extractTar();

    tarExtract.on('entry', (header, stream, next) => {
      if (header.type !== 'file') {
        stream.resume();
        next();
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: unknown) => chunks.push(chunk as Buffer));
      stream.on('error', reject);
      stream.on('end', () => {
        files.set(
          header.name.replace(/^\.\//, ''),
          new Uint8Array(Buffer.concat(chunks))
        );
        next();
      });
      stream.resume();
    });

    tarExtract.on('finish', () => resolve(files));
    tarExtract.on('error', reject);
    tarExtract.end(gunzipped);
  });
}

function buildSkill(
  entry: SkillIndexEntry,
  unpacked: Map<string, Uint8Array>
): SupabaseSkill | undefined {
  const files: SkillFile[] = [];
  let totalBytes = 0;

  for (const [path, bytes] of unpacked) {
    totalBytes += bytes.byteLength;
    files.push({
      uri: `${SKILL_URI_SCHEME}//${entry.name}/${path}`,
      path,
      bytes,
      digest: sha256(bytes),
      size: bytes.byteLength,
      mimeType: guessMimeType(path),
    });
  }

  // SEP-2640 says servers SHOULD NOT exceed 512 files or 16 MiB per skill,
  // but does not forbid larger ones: hosts MUST support skills up to these
  // limits and MAY support larger ones. So this isn't a wire-protocol error —
  // nothing in the spec says a host must reject an oversized skill. Skipping
  // (rather than serving) one this large is a local, practical safeguard
  // against unbounded memory use from unpacking a whole tarball in memory,
  // not a spec-mandated rejection. A future revision could stream/paginate
  // large skills instead of skipping them outright.
  if (totalBytes > MAX_SKILL_TOTAL_BYTES) {
    console.error(
      `[skills] skipping skill "${entry.name}": ${totalBytes} bytes exceeds the ${MAX_SKILL_TOTAL_BYTES}-byte practical limit this server enforces (SEP-2640 permits larger skills; hosts are not required to reject them)`
    );
    return undefined;
  }

  const manifestUri = `${SKILL_URI_SCHEME}//${entry.name}/${SKILL_MANIFEST_FILENAME}`;
  if (!files.some((file) => file.uri === manifestUri)) {
    throw new Error(
      `skill "${entry.name}" archive does not contain a ${SKILL_MANIFEST_FILENAME} file`
    );
  }

  return {
    uri: manifestUri,
    // The discovery index's `name` / `description` are sourced from the same
    // SKILL.md frontmatter the archive carries, so they're used directly
    // here instead of re-parsing YAML out of the unpacked file. Any further
    // frontmatter keys (e.g. `metadata.version`) are not surfaced yet — see
    // the PR description for this as a follow-up.
    frontmatter: { name: entry.name, description: entry.description },
    files,
  };
}

/**
 * Fetches Supabase's published agent skills index, downloads and verifies
 * every skill's archive against its published digest, and unpacks it into
 * individually addressable files with per-file digests and sizes — the shape
 * the MCP Skills extension (SEP-2640) needs for `skills/list`, `skills/get`,
 * and `resources/read`.
 */
export async function fetchSkillsManifest(
  options: FetchSkillsManifestOptions = {}
): Promise<SkillsManifest> {
  const {
    indexUrl = AGENT_SKILLS_INDEX_URL,
    fetchImpl = fetch,
    userAgent,
  } = options;

  const index = skillsIndexSchema.parse(
    await fetchJson(indexUrl, fetchImpl, userAgent)
  );

  const built = await Promise.all(
    index.skills.map(async (entry) => {
      const tarball = await downloadTarball(entry, fetchImpl, userAgent);
      const unpacked = await unpackTarball(tarball);
      return buildSkill(entry, unpacked);
    })
  );

  // buildSkill() returns undefined for a skill it skips (see the comment
  // there); filter those out rather than serving a hole in the manifest.
  const skills = built.filter(
    (skill): skill is SupabaseSkill => skill !== undefined
  );

  return { skills, fetchedAt: Date.now() };
}
