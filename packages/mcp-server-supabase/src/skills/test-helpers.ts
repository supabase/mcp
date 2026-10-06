import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { pack } from 'tar-stream';

/** Builds a gzipped tar archive in memory from a flat path -> contents map. */
export async function buildTarball(
  files: Record<string, string>
): Promise<Buffer> {
  const tarPack = pack();

  for (const [path, contents] of Object.entries(files)) {
    tarPack.entry({ name: path }, contents);
  }
  tarPack.finalize();

  const chunks: Buffer[] = [];
  for await (const chunk of tarPack) {
    chunks.push(chunk as Buffer);
  }

  return gzipSync(Buffer.concat(chunks));
}

export function sha256(buffer: Buffer): string {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

/** A minimal fetch-compatible stub backed by an in-memory URL -> body map. */
export function createFakeFetch(
  routes: Record<string, () => Promise<Response> | Response>
): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    const handler = routes[url];
    if (!handler) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return handler();
  }) as typeof fetch;
}
