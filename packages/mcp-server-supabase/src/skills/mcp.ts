import type {
  GetSkillResult,
  ListSkillsResult,
  Skill,
} from '@modelcontextprotocol/core/ext/skills';
import {
  GetSkillRequestParamsSchema,
  ListSkillsRequestParamsSchema,
  SKILLS_EXTENSION_ID,
  SKILLS_GET_METHOD,
  SKILLS_LIST_METHOD,
} from '@modelcontextprotocol/core/ext/skills';
import {
  ProtocolError,
  ProtocolErrorCode,
  type Server,
} from '@modelcontextprotocol/server';
import { resource, type Resource } from '@supabase/mcp-utils';
import { isTextMimeType, toSkillResourceEntries } from './manifest.js';
import type { SkillsProvider } from './provider.js';

/** The cache fields `skills/list` and `skills/get` carry on 2026-07-28. */
type SkillsCacheFields = Pick<ListSkillsResult, 'ttlMs' | 'cacheScope'>;

/**
 * A skills result as served on either protocol era: the cache fields are
 * required on 2026-07-28 and absent on 2025-11-25.
 */
type EraResult<T extends SkillsCacheFields> = Omit<T, keyof SkillsCacheFields> &
  Partial<SkillsCacheFields>;

/**
 * The SDK's own `SkillsExtension` defaults when no cache hint is configured:
 * nothing may be cached beyond the requesting client. Revisit a non-zero
 * `ttlMs` alongside the provider's own TTL.
 */
const SKILLS_CACHE_FIELDS: SkillsCacheFields = {
  ttlMs: 0,
  cacheScope: 'private',
};

/** The first revision of the modern era, whose cacheable results carry `ttlMs` / `cacheScope`. */
const FIRST_MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * The cache fields for a `skills/list` / `skills/get` result on `server`'s
 * negotiated protocol revision.
 *
 * The SDK's `cacheHints` server option and its 2026-07-28 codec only cover a
 * closed list of core methods, so extension results get no cache fields from
 * the SDK. SDK 2.4.0's `SkillsExtension` adds them itself, only on a modern
 * revision, read from the same accessor; this mirrors it so a 2025-11-25
 * response never carries them.
 */
function cacheFieldsFor(server: Server): Partial<SkillsCacheFields> {
  const version = server.getNegotiatedProtocolVersion();
  return version !== undefined && version >= FIRST_MODERN_PROTOCOL_VERSION
    ? { ...SKILLS_CACHE_FIELDS }
    : {};
}

function toWireSkill(
  skill: Awaited<ReturnType<SkillsProvider['getManifest']>>['skills'][number]
): Skill {
  return {
    uri: skill.uri,
    frontmatter: skill.frontmatter,
    resources: toSkillResourceEntries(skill),
  };
}

/**
 * Declares the `io.modelcontextprotocol/skills` capability and serves
 * `skills/list` / `skills/get` for Supabase's published agent skills,
 * resolved live from `provider` on every call.
 *
 * SDK 2.4.0 ships the Skills extension (typescript-sdk#3047) as
 * `SkillsExtension` in `@modelcontextprotocol/server/ext/skills`, but its
 * `attach()` needs an `McpServer` and is `@experimental`, while this server is
 * a low-level `Server` built by `@supabase/mcp-utils`. So this does what
 * `attach()` does for the two methods (declare the capability, register both
 * handlers with the SEP's params schemas, add the cache fields on 2026-07-28)
 * and backs the handlers with `provider`, which owns its own TTL cache and
 * decides when to actually re-fetch. Skill files are served by
 * {@linkcode getSkillsResources} through the server's `resources/read`.
 *
 * The handlers are registered without a `result` schema, as the SDK's own are:
 * the 2.4.0 result schemas require the cache fields, which a 2025-11-25
 * response must not carry.
 *
 * It deliberately does not import `@modelcontextprotocol/server/ext/skills`:
 * `@modelcontextprotocol/server` is a peer dependency that still allows 2.0.0,
 * which has no `./ext/skills` subpath, so a static import of it would break
 * loading this package even with skills disabled. Everything used here comes
 * from `@modelcontextprotocol/core/ext/skills` (a direct dependency) and the
 * stable `Server` API.
 *
 * Must be called before the server connects to a transport: capabilities
 * cannot be registered afterwards. `registerCapabilities` merges into any
 * `extensions` already declared (such as MCP Apps').
 */
export function installSupabaseSkills(
  server: Server,
  provider: SkillsProvider
): void {
  server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: ListSkillsRequestParamsSchema },
    async (): Promise<EraResult<ListSkillsResult>> => {
      const manifest = await provider.getManifest();
      return {
        skills: manifest.skills.map(toWireSkill),
        ...cacheFieldsFor(server),
      };
    }
  );

  server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: GetSkillRequestParamsSchema },
    async (params): Promise<EraResult<GetSkillResult>> => {
      const manifest = await provider.getManifest();
      const skill = manifest.skills.find((skill) => skill.uri === params.uri);
      if (!skill) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown skill URI: ${params.uri}`
        );
      }
      return { skill: toWireSkill(skill), ...cacheFieldsFor(server) };
    }
  );
}

/**
 * Builds the `@supabase/mcp-utils` dynamic `resources` list: one entry per
 * file across every skill `provider` currently has cached, serving the bytes
 * `resources/read` needs for each `skill://` URI a skill's manifest points
 * at. Called fresh on every `resources/list` / `resources/read`, so it
 * reflects whatever `provider.getManifest()` currently has cached.
 */
export function getSkillsResources(
  provider: SkillsProvider
): () => Promise<Resource[]> {
  return async () => {
    const manifest = await provider.getManifest();
    return manifest.skills.flatMap((skill) =>
      skill.files.map((file) =>
        resource(file.uri, {
          name: file.path,
          mimeType: file.mimeType,
          async read(uri: string) {
            return isTextMimeType(file.mimeType)
              ? {
                  uri,
                  mimeType: file.mimeType,
                  text: new TextDecoder().decode(file.bytes),
                }
              : {
                  uri,
                  mimeType: file.mimeType,
                  blob: Buffer.from(file.bytes).toString('base64'),
                };
          },
        })
      )
    );
  };
}
