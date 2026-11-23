import type { CallToolResult } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { parseToolError, parseToolResult } from './tool-result';

const result = (...texts: string[]): CallToolResult => ({
  content: texts.map((text) => ({ type: 'text', text })),
});

describe('parseToolError', () => {
  it('returns plain text, trimmed', () => {
    expect(parseToolError(result('  boom \n'))).toBe('boom');
  });

  it.each([
    ['error.message', '{"error":{"message":"a"}}', 'a'],
    ['message', '{"message":"b"}', 'b'],
    ['error string', '{"error":"c"}', 'c'],
    ['bare JSON string', '"d"', 'd'],
  ])('reads %s from JSON', (_, body, expected) => {
    expect(parseToolError(result(body))).toBe(expected);
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
    expect(parseToolError(r)).toBe('The tool call failed.');
  });

  it('skips blank parts and uses the first with text', () => {
    expect(parseToolError(result('', 'second'))).toBe('second');
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
