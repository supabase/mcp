import type { CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  parseToolResult,
  readToolError,
  readViewData,
  VIEW_DATA_META_KEY,
} from './tool-result';

const result = (...texts: string[]): CallToolResult => ({
  content: texts.map((text) => ({ type: 'text', text })),
});

describe('readToolError', () => {
  it('returns plain text, trimmed', () => {
    expect(readToolError(result('  boom \n')).message).toBe('boom');
  });

  it.each([
    ['error.message', '{"error":{"message":"a"}}', 'a'],
    ['message', '{"message":"b"}', 'b'],
    ['error string', '{"error":"c"}', 'c'],
    ['bare JSON string', '"d"', 'd'],
  ])('reads %s from JSON', (_, body, expected) => {
    expect(readToolError(result(body)).message).toBe(expected);
  });

  it.each([
    ['no content', result()],
    ['blank text', result('   ')],
    ['unknown JSON shape', result('{"foo":1}')],
    ['empty message', result('{"message":"  "}')],
    [
      'non-text content',
      {
        content: [{ type: 'image', data: '', mimeType: 'image/png' }],
      } as CallToolResult,
    ],
  ])('falls back to a generic message for %s', (_, r) => {
    expect(readToolError(r).message).toBe('The tool call failed.');
  });

  it('skips blank parts and uses the first with text', () => {
    expect(readToolError(result('', 'second')).message).toBe('second');
  });
});

describe('readToolError code', () => {
  it('reads error.code from a JSON body', () => {
    const body =
      '{"error":{"name":"ToolCallerError","message":"m","code":"x"}}';
    expect(readToolError(result(body)).code).toBe('x');
  });

  it.each([
    ['plain text', result('boom')],
    ['no code', result('{"error":{"message":"m"}}')],
    ['a non-string code', result('{"error":{"message":"m","code":7}}')],
    ['an empty code', result('{"error":{"message":"m","code":""}}')],
    ['a top-level code', result('{"code":"x"}')],
    ['no content', result()],
  ])('is undefined for %s', (_, r) => {
    expect(readToolError(r).code).toBeUndefined();
  });
});

describe('parseToolResult', () => {
  it('parses the first text part as JSON', () => {
    expect(parseToolResult(result('[1,2]'))).toEqual([1, 2]);
  });

  it('throws with no content', () => {
    expect(() => parseToolResult(result())).toThrow(/no text content/);
  });

  it('throws on non-text first content', () => {
    const r = {
      content: [{ type: 'image', data: '', mimeType: 'image/png' }],
    } as CallToolResult;
    expect(() => parseToolResult(r)).toThrow(/no text content/);
  });

  it('throws on invalid JSON', () => {
    expect(() => parseToolResult(result('not json'))).toThrow(SyntaxError);
  });
});

describe('readViewData', () => {
  it('reads the view data from _meta, not the text', () => {
    const r: CallToolResult = {
      ...result('Opened the issues view for the user.'),
      _meta: { [VIEW_DATA_META_KEY]: { page: 1 } },
    };
    expect(readViewData(r)).toEqual({ page: 1 });
  });

  it('is undefined without view data, even when the text is JSON', () => {
    const r: CallToolResult = {
      ...result('{"id":"abc"}'),
      _meta: { 'supabase.com/dashboardUrl': 'https://example.com' },
    };
    expect(readViewData(r)).toBeUndefined();
    expect(readViewData(result('Opened the issues view.'))).toBeUndefined();
  });
});
