/**
 * Supabase's published discovery index of agent skills. Each entry names a
 * `.tar.gz` archive and its tarball-level sha256 digest — see
 * https://supabase.com/docs/guides/getting-started/ai-skills.md.
 */
export const AGENT_SKILLS_INDEX_URL =
  'https://supabase.com/.well-known/agent-skills';

/**
 * Default freshness window for a fetched skills manifest before the next
 * call re-fetches it. Chosen to keep a hosted server's `skills/list` /
 * `skills/get` reasonably current without re-downloading and re-unpacking
 * every skill archive on every request.
 */
export const DEFAULT_SKILLS_TTL_MS = 5 * 60 * 1000;
