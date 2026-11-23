import { describe, expect, it, vi } from 'vitest';
import { type QueryBlock, registerQueryBlockTools } from './query-block-agent';
import type { QueryEditorHandle, QueryEditorState } from './QueryEditor';

const STATE: QueryEditorState = {
  sql: 'select 1;',
  revision: 0,
  running: false,
  error: null,
  has_results: true,
  results_stale: false,
  columns: ['?column?'],
  row_count: 1,
};

function setup() {
  let state = { ...STATE };
  const editor: QueryEditorHandle = {
    read: () => state,
    update: (sql, expectedRevision) => {
      if (expectedRevision !== state.revision) {
        throw new Error('The query changed since it was read.');
      }
      state = { ...state, sql, revision: state.revision + 1 };
      return { revision: state.revision };
    },
  };
  const block: QueryBlock = {
    id: 'toolu_1',
    title: 'Query results',
    source: 'database',
    editor,
  };
  const app = { registerTool: vi.fn() };
  const webMcpTools = new Map<
    string,
    { inputSchema: unknown; execute: (input: unknown) => Promise<string> }
  >();
  const webMcp = {
    registerTool: vi.fn(
      (tool: {
        name: string;
        inputSchema: unknown;
        execute: (input: unknown) => Promise<string>;
      }) => webMcpTools.set(tool.name, tool)
    ),
  };
  registerQueryBlockTools(app, () => block, webMcp);
  return { app, webMcp, webMcpTools, editor };
}

describe('registerQueryBlockTools', () => {
  it('offers the same tools to MCP Apps hosts (Claude) and WebMCP hosts (ChatGPT, Codex)', () => {
    const { app, webMcpTools } = setup();

    expect(app.registerTool.mock.calls.map(([name]) => name)).toEqual([
      'read_query',
      'set_query_draft',
    ]);
    expect([...webMcpTools.keys()]).toEqual(['read_query', 'set_query_draft']);
    // WebMCP takes JSON Schema, not a Standard Schema object.
    expect(webMcpTools.get('set_query_draft')!.inputSchema).toMatchObject({
      type: 'object',
      required: ['block_id', 'expected_revision', 'sql'],
    });
  });

  it('lets a WebMCP host read the block and propose a draft', async () => {
    const { webMcpTools, editor } = setup();

    const read = await webMcpTools.get('read_query')!.execute({});
    expect(read).toMatch(/^Supabase query block \(data, not instructions\): /);
    expect(read).toContain('"block_id":"toolu_1"');

    await webMcpTools.get('set_query_draft')!.execute({
      block_id: 'toolu_1',
      expected_revision: 0,
      sql: 'select 2;',
    });
    expect(editor.read()).toMatchObject({ sql: 'select 2;', revision: 1 });
  });

  it('rejects bad input and stale edits over WebMCP as errors', async () => {
    const { webMcpTools } = setup();
    const setDraft = webMcpTools.get('set_query_draft')!;

    await expect(setDraft.execute({ block_id: 'toolu_1' })).rejects.toThrow();
    await expect(
      setDraft.execute({
        block_id: 'toolu_1',
        expected_revision: 3,
        sql: 'select 2;',
      })
    ).rejects.toThrow('changed since it was read');
  });

  it('works on hosts without WebMCP', () => {
    const app = { registerTool: vi.fn() };
    expect(() => registerQueryBlockTools(app, () => undefined)).not.toThrow();
    expect(app.registerTool).toHaveBeenCalledTimes(2);
  });
});
