import type { SqlScan } from './sql-lexer.js';

const wordPart = String.raw`[\w$\u0080-￿]`;
const doStart = new RegExp(String.raw`^\s*do(?!${wordPart})`, 'i');
const executeWord = new RegExp(
  String.raw`(?<!${wordPart})execute(?!${wordPart})`,
  'i'
);
const asEnd = new RegExp(String.raw`(?<!${wordPart})as\s*$`, 'i');
const literalPrefix = new RegExp(String.raw`(?<!${wordPart})(?:e|u&)$`, 'i');

export function maskDataLiterals(sql: string, scan: SqlScan): string {
  const open = scan.unterminated ? scan.spans.at(-1) : undefined;
  let cleaned = '';
  let started = false;
  let codeBodies = false;
  let afterAs = false;
  for (const span of scan.spans) {
    const text = sql.slice(span.start, span.end);
    switch (span.kind) {
      case 'line-comment':
      case 'block-comment':
        cleaned += ' ';
        break;
      case 'code':
        cleaned += text;
        for (const [index, part] of text.split(';').entries()) {
          if (index > 0) started = codeBodies = afterAs = false;
          const words = part.replace(literalPrefix, '');
          if (!words.trim()) continue;
          if (!started) codeBodies = doStart.test(words);
          started = true;
          codeBodies ||= executeWord.test(words);
          afterAs = asEnd.test(words);
        }
        break;
      case 'quoted-identifier':
        cleaned += text;
        started = true;
        afterAs = false;
        break;
      default:
        cleaned += codeBodies || afterAs || span === open ? text : "''";
        started = true;
        afterAs = false;
    }
  }
  return cleaned;
}
