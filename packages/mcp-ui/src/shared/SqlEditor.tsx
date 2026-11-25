import './sql-editor.css';

import { useMemo, type KeyboardEvent } from 'react';

import { tokenizeSql, type SqlToken } from './sql-tokens';

const INDENT = '  ';

/** Tokens split into lines, so each line gets its own number. */
function toLines(sql: string): SqlToken[][] {
  const lines: SqlToken[][] = [[]];
  for (const token of tokenizeSql(sql)) {
    token.text.split('\n').forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ text: part, kind: token.kind });
    });
  }
  return lines;
}

/**
 * The SQL editor of the Supabase surfaces in MCP Apps hosts, which use
 * CodeMirror there: line numbers, SQL highlighting in Studio's code colours,
 * wrapped lines, two-space Tab, ⌘/Ctrl+Enter to run. Here it is a textarea
 * over a highlighted copy of its text, so the view needs no editor library.
 */
export function SqlEditor({
  value,
  onChange,
  onRun,
  readOnly = false,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  readOnly?: boolean;
  id?: string;
}) {
  const lines = useMemo(() => toLines(value), [value]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onRun?.();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !readOnly) {
      event.preventDefault();
      const input = event.currentTarget;
      input.setRangeText(
        INDENT,
        input.selectionStart,
        input.selectionEnd,
        'end'
      );
      onChange(input.value);
    }
  }

  return (
    <div
      className="sql-editor"
      // Sizes the gutter for the widest line number.
      style={{
        ['--sb-component-sql-editor-digits' as string]: Math.max(
          2,
          String(lines.length).length
        ),
      }}
    >
      <div data-slot="content">
        <div data-slot="lines" aria-hidden="true">
          {lines.map((tokens, index) => (
            // Lines are positions, not items: they have no identity to keep.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <div data-slot="line" key={index}>
              <span data-slot="line-number">{index + 1}</span>
              <span data-slot="line-text">
                {tokens.length === 0
                  ? '​'
                  : tokens.map((token, tokenIndex) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above
                      <span key={tokenIndex} data-token={token.kind}>
                        {token.text}
                      </span>
                    ))}
              </span>
            </div>
          ))}
        </div>
        <textarea
          id={id}
          data-slot="input"
          aria-label="SQL query"
          placeholder="Write a SQL query…"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          value={value}
          readOnly={readOnly}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </div>
    </div>
  );
}
