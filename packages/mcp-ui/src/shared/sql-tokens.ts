/**
 * A small SQL tokenizer for highlighting, standing in for CodeMirror's SQL
 * language in the Supabase surfaces' editor. It only colours text: anything
 * it doesn't recognise is plain.
 */
export type SqlTokenKind =
  | 'keyword'
  | 'string'
  | 'literal'
  | 'type'
  | 'operator'
  | 'comment';

export type SqlToken = { text: string; kind?: SqlTokenKind };

const KEYWORDS = new Set(
  `all alter analyze and any as asc begin between by cascade case check
  column commit constraint create cross default delete desc distinct do drop
  else end except exists explain filter foreign from full grant group having
  if ilike in index inner insert intersect into is join key lateral left like
  limit not nulls offset on or order outer over partition policy primary
  references returning revoke right rollback schema select set table then to
  trigger truncate union unique update using values view when where window
  with`.split(/\s+/)
);

const TYPES = new Set(
  `bigint bigserial bool boolean bytea char character date decimal double
  float float4 float8 int int2 int4 int8 integer interval json jsonb numeric
  precision real serial smallint text time timestamp timestamptz uuid varchar
  count sum avg min max now coalesce`.split(/\s+/)
);

const LITERALS = new Set(['true', 'false', 'null']);

/** Alternatives in the order they're tried; the first group that matches wins. */
const TOKEN = new RegExp(
  [
    /(--[^\n]*|\/\*[\s\S]*?(?:\*\/|$))/.source, // 1 comment
    /('(?:[^']|'')*'?|"(?:[^"]|"")*"?)/.source, // 2 string or quoted name
    /(\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/.source, // 3 number
    /([a-z_][a-z0-9_$]*)/.source, // 4 word
    /(::|[=<>!+\-*/%|&^~]+)/.source, // 5 operator
  ].join('|'),
  'gi'
);

export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let last = 0;
  for (const match of sql.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) tokens.push({ text: sql.slice(last, index) });
    const [text, comment, string, number, word] = match;
    let kind: SqlTokenKind | undefined;
    if (comment) kind = 'comment';
    // Double quotes name things; only single quotes are strings.
    else if (string) kind = string.startsWith("'") ? 'string' : undefined;
    else if (number) kind = 'literal';
    else if (word) {
      const lower = word.toLowerCase();
      kind = LITERALS.has(lower)
        ? 'literal'
        : KEYWORDS.has(lower)
          ? 'keyword'
          : TYPES.has(lower)
            ? 'type'
            : undefined;
    } else kind = 'operator';
    tokens.push({ text, kind });
    last = index + text.length;
  }
  if (last < sql.length) tokens.push({ text: sql.slice(last) });
  return tokens;
}
