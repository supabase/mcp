import { describe, expect, it } from 'vitest';
import { normalizeFilename } from './edge-function.js';

// The function imports `resolve` from `node:path/posix` deliberately:
// Deno's local dev server always uses POSIX paths (the deployment prefix
// is hardcoded to `/tmp/user_fn_<id>/`), and on Windows the platform-default
// `node:path` would replace the leading slash with a drive letter and
// backslashes, breaking both the absolute-path merge and the
// `path.startsWith(prefix)` strip below. These tests cover both the
// Deno 1 (absolute POSIX) and Deno 2 (relative) input shapes; the
// fix keeps them green on Windows too.
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
