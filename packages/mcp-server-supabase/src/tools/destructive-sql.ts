import { maskDataLiterals } from './sql-data-literals.js';
import { lexSql, type SqlScan } from './sql-lexer.js';

/** Adapted from supabase/supabase apps/studio (SQLEditor.constants.ts, SQLEditor.utils.ts, lib/helpers.ts), Apache-2.0. */

const sqlIdentifier = String.raw`(?:"(?:[^"]|"")+"|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*)`;

// Match starts only: no candidate is allowed to rescan the remaining SQL.
const directDropColumnRegex = new RegExp(
  String.raw`^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?${sqlIdentifier}(?:\s*\.\s*${sqlIdentifier})?\s+drop\s+(?!constraint(?![\w$\u0080-\uffff]))(?:column\s+)?(?:if\s+exists\s+)?${sqlIdentifier}(?:\s+(?:cascade|restrict))?\s*$`,
  'i'
);
const quotedDestructiveStart =
  /['"]\s*(drop\b|delete\b|truncate\b|alter\s+table\b)/gi;
const dollarDestructiveStart =
  /execute\s+\$\w*\$\s*(drop\b|delete\b|truncate\b|alter\s+table\b)/gi;
const concatDestructiveStart = /\b(drop|delete|truncate|alter\s+table)\b/gi;

function hasDestructiveStart(sql: string, starts: RegExp): boolean {
  starts.lastIndex = 0;
  let firstAlterEnd = -1;
  let match: RegExpExecArray | null;
  while ((match = starts.exec(sql)) !== null) {
    if (!/^alter/i.test(match[1]!)) {
      return true;
    }
    if (firstAlterEnd === -1) {
      firstAlterEnd = starts.lastIndex;
    }
  }
  // Only the earliest ALTER matters: every later suffix is contained in it.
  return (
    firstAlterEnd !== -1 && /\bdrop\s+column\b/i.test(sql.slice(firstAlterEnd))
  );
}

const updateWithoutWhereRegex =
  /(?:^|;)\s*update\s+(?:"(?:[^"]|"")*"|[\w]+)(?:\.(?:"(?:[^"]|"")*"|[\w]+))?\s+set\s+[\w\W]+?(?!\s*where\s)/is;

function removeComments(sql: string, scan: SqlScan): string {
  let parts: string[] | undefined;
  let offset = 0;
  for (const span of scan.spans) {
    if (span.kind === 'line-comment' || span.kind === 'block-comment') {
      (parts ??= []).push(sql.slice(offset, span.start));
      offset = span.end;
    }
  }
  if (!parts) return sql;
  parts.push(sql.slice(offset));
  return parts.join('');
}

export function removeCommentsFromSql(sql: string): string {
  return removeComments(sql, lexSql(sql));
}

function checkDestructiveQueryFromScan(sql: string, scan: SqlScan): boolean {
  const cleanedSql = maskDataLiterals(sql, scan);
  // Retain the broad explicit-column warning, but search its suffix only once.
  const alter = /(?:^|;)\s*alter\s+table\s+/i.exec(cleanedSql);
  if (
    alter &&
    /\sdrop\s+column\s/i.test(cleanedSql.slice(alter.index + alter[0].length))
  ) {
    return true;
  }

  for (const statement of cleanedSql.split(';')) {
    if (
      /^\s*(drop|delete|truncate)\s/i.test(statement) ||
      directDropColumnRegex.test(statement)
    ) {
      return true;
    }
    const execute = /execute\s+/i.exec(statement);
    if (
      execute &&
      (hasDestructiveStart(
        statement.slice(execute.index + execute[0].length),
        quotedDestructiveStart
      ) ||
        hasDestructiveStart(statement, dollarDestructiveStart))
    ) {
      return true;
    }
  }

  // These original patterns allow semicolons inside their arguments. Consume
  // through the first closing parenthesis and its statement suffix, preserving
  // literal concatenation without revisiting overlapping call starts.
  const calls = /execute\s+(format|concat(?:_ws)?)\s*\([^)]*(?:\)[^;]*|$)/gi;
  let call: RegExpExecArray | null;
  while ((call = calls.exec(cleanedSql)) !== null) {
    if (
      hasDestructiveStart(
        call[0],
        call[1]!.toLowerCase() === 'format'
          ? quotedDestructiveStart
          : concatDestructiveStart
      )
    ) {
      return true;
    }
  }
  return false;
}

export function checkDestructiveQuery(sql: string): boolean {
  return checkDestructiveQueryFromScan(sql, lexSql(sql));
}

const valueDollarQuoteStatement =
  /^\s*(?:update\s|explain(?![\w$\u0080-\uffff]))/i;

// Dollar and comment bodies still expose their semicolons to this policy:
// UPDATE statements inside DO bodies must remain visible. Dollar values in
// UPDATE and EXPLAIN are masked so a WHERE or semicolon in a value cannot
// change the statement classification.
function splitStatements(sql: string, scan: SqlScan): string[] {
  if (scan.unterminated && scan.unterminated !== 'block-comment') {
    // Keep the historical plain-split fallback for incomplete quoted input.
    const masked = scan.spans
      .map((span) =>
        span.kind === 'string' ||
        span.kind === 'e-string' ||
        span.kind === 'quoted-identifier'
          ? span.kind === 'quoted-identifier'
            ? '""'
            : "''"
          : sql.slice(span.start, span.end)
      )
      .join('');
    return masked.split(';');
  }
  const statements: string[] = [];
  let blanked = '';
  const append = (text: string) => {
    let offset = 0;
    for (let separator = text.indexOf(';'); separator >= 0; ) {
      blanked += text.slice(offset, separator);
      statements.push(blanked);
      blanked = '';
      offset = separator + 1;
      separator = text.indexOf(';', offset);
    }
    blanked += text.slice(offset);
  };

  for (const span of scan.spans) {
    switch (span.kind) {
      case 'code':
        append(sql.slice(span.start, span.end));
        break;
      case 'line-comment':
        blanked += '--';
        break;
      case 'block-comment': {
        blanked += '/*';
        for (let i = span.start + 2; i < span.end; i++) {
          if (sql[i] === ';') {
            statements.push(blanked);
            blanked = '';
          }
        }
        if (scan.unterminated !== 'block-comment') blanked += '*/';
        break;
      }
      case 'string':
      case 'e-string':
        blanked += "''";
        break;
      case 'quoted-identifier':
        blanked += '""';
        break;
      case 'dollar-body': {
        const tagEnd = sql.indexOf('$', span.start + 1) + 1;
        const tag = sql.slice(span.start, tagEnd);
        if (valueDollarQuoteStatement.test(blanked)) {
          blanked += tag + tag;
        } else {
          append(sql.slice(span.start, span.end));
        }
        break;
      }
    }
  }
  statements.push(blanked);
  return statements;
}

function isUpdateWithoutWhereFromScan(sql: string, scan: SqlScan): boolean {
  return splitStatements(sql, scan).some(
    (statement) =>
      statement.trim().toLowerCase().startsWith('update') &&
      updateWithoutWhereRegex.test(statement) &&
      !/where\s/i.test(statement)
  );
}

export function isUpdateWithoutWhere(sql: string): boolean {
  return isUpdateWithoutWhereFromScan(sql, lexSql(sql));
}

const explainStart = /^\s*explain(?![\w$\u0080-\uffff])\s*/i;
const legacyExplainOptions =
  /^(?:(analy[sz]e)(?![\w$\u0080-\uffff])\s*)?(?:verbose(?![\w$\u0080-\uffff])\s*)?/i;

type Explain =
  | { kind: 'plan' }
  | { kind: 'analyze'; body: string }
  | { kind: 'unparsed' };

// Only ANALYZE runs the statement: https://www.postgresql.org/docs/current/sql-explain.html
// `statement` comes from splitStatements, so literals are already blanked.
function parseExplain(statement: string): Explain | undefined {
  const start = explainStart.exec(statement);
  if (!start) {
    return undefined;
  }
  const rest = statement.slice(start[0].length);
  if (!rest.startsWith('(')) {
    const legacy = legacyExplainOptions.exec(rest)!;
    return legacy[1]
      ? { kind: 'analyze', body: rest.slice(legacy[0].length) }
      : { kind: 'plan' };
  }
  const close = rest.indexOf(')');
  if (close === -1) {
    return { kind: 'unparsed' };
  }
  let analyze = false;
  for (const option of rest.slice(1, close).split(',')) {
    const [name = '', value, ...extra] = option.trim().split(/\s+/);
    if (!/^[a-z_]\w*$/i.test(name) || extra.length > 0) {
      return { kind: 'unparsed' };
    }
    if (!/^analy[sz]e$/i.test(name)) {
      continue;
    }
    const flag = value?.toLowerCase();
    if (
      flag === undefined ||
      flag === 'true' ||
      flag === 'on' ||
      flag === '1'
    ) {
      analyze = true;
    } else if (flag !== 'false' && flag !== 'off' && flag !== '0') {
      return { kind: 'unparsed' };
    }
  }
  return analyze
    ? { kind: 'analyze', body: rest.slice(close + 1) }
    : { kind: 'plan' };
}

/** `statement` has quoted spans and comments masked by the shared lexer. */
export function isPlannerOnlyExplainStatement(statement: string): boolean {
  return parseExplain(statement)?.kind === 'plan';
}

export function isDestructiveSql(sql: string): boolean {
  const scan = lexSql(sql);
  let hasStatement = false;
  let onlyPlans = true;
  for (const raw of splitStatements(sql, scan)) {
    const statement = raw.replace(/--|\/\*|\*\//g, ' ').trim();
    if (!statement) continue;
    hasStatement = true;
    const explain = parseExplain(statement);
    if (explain?.kind === 'unparsed') return true;
    if (explain?.kind === 'analyze') {
      const bodyScan = lexSql(explain.body);
      if (
        checkDestructiveQueryFromScan(explain.body, bodyScan) ||
        isUpdateWithoutWhereFromScan(explain.body, bodyScan)
      ) {
        return true;
      }
    }
    if (explain?.kind !== 'plan') onlyPlans = false;
  }
  if (hasStatement && onlyPlans) return false;
  return (
    checkDestructiveQueryFromScan(sql, scan) ||
    isUpdateWithoutWhereFromScan(sql, scan)
  );
}
