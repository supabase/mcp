import { describe, expect, it } from 'vitest';
import {
  getFilenameFromUrlOrPath,
  normalizeFilename,
} from './edge-function.js';

describe('normalizeFilename', () => {
  it('handles deno 1 paths', () => {
    const result = normalizeFilename({
      deploymentId:
        'xnzcmvwhvqonuunmwgdz_2b72daae-bbb3-437f-80cb-46f2df0463d1_2',
      filename:
        '/tmp/user_fn_xnzcmvwhvqonuunmwgdz_2b72daae-bbb3-437f-80cb-46f2df0463d1_2/source/index.ts',
    });
    expect(result).toBe('index.ts');
  });

  it('handles deno 2 paths', () => {
    const result = normalizeFilename({
      deploymentId:
        'xnzcmvwhvqonuunmwgdz_2b72daae-bbb3-437f-80cb-46f2df0463d1_2',
      filename: 'source/index.ts',
    });
    expect(result).toBe('index.ts');
  });

  it("doesn't interfere with nested directories", () => {
    const result = normalizeFilename({
      deploymentId:
        'xnzcmvwhvqonuunmwgdz_2b72daae-bbb3-437f-80cb-46f2df0463d1_2',
      filename: '/my/local/source/index.ts',
    });
    expect(result).toBe('/my/local/source/index.ts');
  });
});

describe('getFilenameFromUrlOrPath', () => {
  it('converts file URLs to paths', () => {
    expect(
      getFilenameFromUrlOrPath('file:///tmp/user_fn_abc_1/source/index.ts')
    ).toBe('/tmp/user_fn_abc_1/source/index.ts');
  });

  it('passes through absolute paths', () => {
    expect(getFilenameFromUrlOrPath('/tmp/user_fn_abc_1/source/index.ts')).toBe(
      '/tmp/user_fn_abc_1/source/index.ts'
    );
  });

  it('passes through relative paths', () => {
    expect(getFilenameFromUrlOrPath('supabase/functions/hello/index.ts')).toBe(
      'supabase/functions/hello/index.ts'
    );
  });

  it('passes through non-file URLs', () => {
    expect(getFilenameFromUrlOrPath('https://example.com/index.ts')).toBe(
      'https://example.com/index.ts'
    );
  });
});
