type SqlSpanKind =
  | 'code'
  | 'line-comment'
  | 'block-comment'
  | 'string'
  | 'e-string'
  | 'quoted-identifier'
  | 'dollar-body';

type SqlSpan = { kind: SqlSpanKind; start: number; end: number };

type UnterminatedKind = Exclude<SqlSpanKind, 'code' | 'line-comment'>;
export type SqlScan = {
  spans: SqlSpan[];
  unterminated: UnterminatedKind | undefined;
};

const identifierPart = /[\w$\u0080-\uffff]/;
const dollarQuoteTag = /\$(?:[a-z_\u0080-\uffff][\w\u0080-\uffff]*)?\$/iy;

/** Returns source offsets so callers can choose how to treat quoted bodies. */
export function lexSql(sql: string): SqlScan {
  const spans: SqlSpan[] = [];
  let codeStart = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    let kind: Exclude<SqlSpanKind, 'code'>;
    let end: number;
    let unterminated: UnterminatedKind | undefined;

    if (ch === '-' && sql[i + 1] === '-') {
      kind = 'line-comment';
      end = i + 2;
      while (end < sql.length && sql[end] !== '\n' && sql[end] !== '\r') {
        end++;
      }
    } else if (ch === '/' && sql[i + 1] === '*') {
      kind = 'block-comment';
      let depth = 1;
      end = i + 2;
      while (depth && end < sql.length) {
        if (sql.startsWith('/*', end)) {
          depth++;
          end += 2;
        } else if (sql.startsWith('*/', end)) {
          depth--;
          end += 2;
        } else {
          end++;
        }
      }
      if (depth) unterminated = kind;
    } else if (ch === "'" || ch === '"') {
      const eString =
        ch === "'" &&
        (sql[i - 1] === 'e' || sql[i - 1] === 'E') &&
        !identifierPart.test(sql[i - 2] ?? '');
      kind = ch === '"' ? 'quoted-identifier' : eString ? 'e-string' : 'string';
      end = i + 1;
      let closed = false;
      while (end < sql.length) {
        if (eString && sql[end] === '\\') {
          end += 2;
        } else if (sql[end] === ch) {
          if (sql[end + 1] === ch) {
            end += 2;
          } else {
            end++;
            closed = true;
            break;
          }
        } else {
          end++;
        }
      }
      if (!closed) {
        end = sql.length;
        unterminated = kind;
      }
    } else if (ch === '$' && !identifierPart.test(sql[i - 1] ?? '')) {
      dollarQuoteTag.lastIndex = i;
      const tag = dollarQuoteTag.exec(sql)?.[0];
      if (tag === undefined) {
        i++;
        continue;
      }
      kind = 'dollar-body';
      const closing = sql.indexOf(tag, i + tag.length);
      end = closing === -1 ? sql.length : closing + tag.length;
      if (closing === -1) unterminated = kind;
    } else {
      i++;
      continue;
    }

    if (codeStart < i) spans.push({ kind: 'code', start: codeStart, end: i });
    spans.push({ kind, start: i, end });
    i = end;
    codeStart = end;
    if (unterminated) return { spans, unterminated };
  }
  if (codeStart < sql.length) {
    spans.push({ kind: 'code', start: codeStart, end: sql.length });
  }
  return { spans, unterminated: undefined };
}
