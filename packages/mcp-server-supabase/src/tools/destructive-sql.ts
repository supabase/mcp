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

export function removeCommentsFromSql(sql: string): string {
  // Removing single-line comments:
  let cleanedSql = sql.replace(/--.*$/gm, '');

  // Advance past each closed block once. A missing terminator must not make
  // every subsequent /* retry the same suffix. This remains a comment heuristic,
  // not a SQL lexer (including inside string literals).
  const parts: string[] = [];
  let offset = 0;
  let start = cleanedSql.indexOf('/*', offset);
  while (start !== -1) {
    const end = cleanedSql.indexOf('*/', start + 2);
    if (end === -1) {
      break;
    }
    parts.push(cleanedSql.slice(offset, start));
    offset = end + 2;
    start = cleanedSql.indexOf('/*', offset);
  }
  if (offset !== 0) {
    parts.push(cleanedSql.slice(offset));
    cleanedSql = parts.join('');
  }

  return cleanedSql;
}

export function checkDestructiveQuery(sql: string): boolean {
  const cleanedSql = removeCommentsFromSql(sql);
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

// Blank quoted spans while splitting so the WHERE scan shares one lexer with
// statement boundaries. E'' / e'' strings treat backslash as an escape
// (`E'it\'s'`), matching Postgres. Doubled quotes stay part of the same span.
function blankQuotedSpans(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'" || ch === '"') {
      const backslashEscapes =
        ch === "'" &&
        /e/i.test(sql[i - 1] ?? '') &&
        !/[\w$\u0080-\uffff]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (backslashEscapes && sql[j] === '\\') {
          j += 2;
        } else if (sql[j] === ch) {
          if (sql[j + 1] !== ch) {
            closed = true;
            break;
          }
          j += 2;
        } else {
          j++;
        }
      }
      out += ch === "'" ? "''" : '""';
      i = closed ? j + 1 : sql.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const dollarQuoteTag = /\$(?:[a-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/iy;

// Split on semicolons, except those inside a single-quoted string literal
// (including E'' strings with backslash escapes) or a double-quoted
// identifier, so `SET note = 'a; b' WHERE ...` stays one statement.
// Quoted spans and comment bodies are blanked in the returned statements so a
// later WHERE check cannot see tokens that only appeared inside a literal or
// a comment (`-- where needed`).
// Inside dollar-quoted bodies and comments, quotes are not tracked and every
// semicolon still splits, as before: a function or DO body is code whose
// statements are checked one by one. Block comments nest; `--` ends at a bare
// `\r` or `\n`. If a quote is left unterminated, fall back to the plain split
// rather than letting it hide the rest of the input.
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let blanked = '';
  let i = 0;
  let dollarUntil: string | undefined;
  let blockDepth = 0;
  let inLineComment = false;

  const push = () => {
    statements.push(blanked);
    blanked = '';
  };

  while (i < sql.length) {
    const ch = sql[i]!;

    if (inLineComment) {
      if (ch === '\n' || ch === '\r') {
        inLineComment = false;
        blanked += ch;
      }
      i++;
      continue;
    }

    if (blockDepth > 0) {
      if (ch === ';') {
        push();
        i++;
        continue;
      }
      if (ch === '/' && sql[i + 1] === '*') {
        blanked += '/*';
        blockDepth++;
        i += 2;
        continue;
      }
      if (ch === '*' && sql[i + 1] === '/') {
        blanked += '*/';
        blockDepth--;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (dollarUntil !== undefined) {
      if (ch === ';') {
        push();
        i++;
        continue;
      }
      if (sql.startsWith(dollarUntil, i)) {
        blanked += dollarUntil;
        i += dollarUntil.length;
        dollarUntil = undefined;
        continue;
      }
      blanked += ch;
      i++;
      continue;
    }

    if (ch === ';') {
      push();
      i++;
      continue;
    }

    if (ch === '$' && !/[\w$\u0080-\uffff]/.test(sql[i - 1] ?? '')) {
      dollarQuoteTag.lastIndex = i;
      const tag = dollarQuoteTag.exec(sql)?.[0];
      if (tag !== undefined) {
        blanked += tag;
        dollarUntil = tag;
        i += tag.length;
        continue;
      }
    }

    if (ch === '-' && sql[i + 1] === '-') {
      blanked += '--';
      inLineComment = true;
      i += 2;
      continue;
    }

    if (ch === '/' && sql[i + 1] === '*') {
      blanked += '/*';
      blockDepth = 1;
      i += 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const backslashEscapes =
        ch === "'" &&
        /e/i.test(sql[i - 1] ?? '') &&
        !/[\w$\u0080-\uffff]/.test(sql[i - 2] ?? '');
      let j = i + 1;
      let closed = false;
      while (j < sql.length) {
        if (backslashEscapes && sql[j] === '\\') {
          j += 2;
        } else if (sql[j] === ch) {
          if (sql[j + 1] !== ch) {
            closed = true;
            break;
          }
          j += 2;
        } else {
          j++;
        }
      }
      if (!closed) {
        return sql.split(';').map(blankQuotedSpans);
      }
      blanked += ch === "'" ? "''" : '""';
      i = j + 1;
      continue;
    }

    blanked += ch;
    i++;
  }
  push();
  return statements;
}

export function isUpdateWithoutWhere(sql: string): boolean {
  const updateStatements = splitStatements(sql).filter((statement) =>
    statement.trim().toLowerCase().startsWith('update')
  );
  return updateStatements.some(
    (statement) =>
      updateWithoutWhereRegex.test(statement) && !/where\s/i.test(statement)
  );
}

export function isDestructiveSql(sql: string): boolean {
  return checkDestructiveQuery(sql) || isUpdateWithoutWhere(sql);
}
