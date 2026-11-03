import type { Skill } from '@modelcontextprotocol/core/ext/skills';
import {
  GetSkillRequestParamsSchema,
  GetSkillResultSchema,
  ListSkillsRequestParamsSchema,
  ListSkillsResultSchema,
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
 * The SDK's `installSkills()` (`@modelcontextprotocol/server/ext/skills`,
 * SEP-2640 phase 1, typescript-sdk#2818) takes a fixed skill list captured at
 * install time, with no live-provider hook. To answer every request from the
 * current `.well-known/agent-skills` index — the point of this feature, so a
 * new skill release needs no mcp-server-supabase release — this does what
 * `installSkills()` does (declare the capability, then register both handlers
 * with the SEP's wire schemas) but backs the handlers with `provider`, which
 * owns its own TTL cache and decides when to actually re-fetch.
 *
 * It deliberately does not import `@modelcontextprotocol/server/ext/skills`:
 * `@modelcontextprotocol/server` is a peer dependency, and consumers on the
 * stable SDK (2.0.0) have no `./ext/skills` subpath, so a static import of it
 * would break loading this package even with skills disabled. Everything used
 * here comes from `@modelcontextprotocol/core/ext/skills` (a direct
 * dependency) and the stable `Server` API.
 *
 * Must be called before the server connects to a transport: capabilities
 * cannot be registered afterwards.
 */
export function installSupabaseSkills(
  server: Server,
  provider: SkillsProvider
): void {
  server.registerCapabilities({ extensions: { [SKILLS_EXTENSION_ID]: {} } });

  server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: ListSkillsRequestParamsSchema, result: ListSkillsResultSchema },
    async () => {
      const manifest = await provider.getManifest();
      return { skills: manifest.skills.map(toWireSkill) };
    }
  );

  server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: GetSkillRequestParamsSchema, result: GetSkillResultSchema },
    async (params) => {
      const manifest = await provider.getManifest();
      const skill = manifest.skills.find((skill) => skill.uri === params.uri);
      if (!skill) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown skill URI: ${params.uri}`
        );
      }
      return { skill: toWireSkill(skill) };
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
