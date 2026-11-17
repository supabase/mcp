import type { App } from '@modelcontextprotocol/ext-apps';
import { parseToolResult } from './tool-result';

/**
 * Calls a tool on the originating server and parses its JSON text result.
 * Throws on transport errors and on tool errors (including unknown tools).
 */
export async function callTool<T>(
  app: App,
  name: string,
  args: Record<string, unknown>
): Promise<T> {
  const result = await app.callServerTool({ name, arguments: args });
  return parseToolResult<T>(result);
}

/** The call would target the scoped project instead of the requested one. */
export class ScopedServerError extends Error {
  constructor() {
    super('Not available while the server is scoped to one project.');
  }
}

/**
 * In project-scoped mode the server injects `project_id`, the project it was
 * scoped to, and rejects it as an unrecognized key (its args are parsed with a
 * strict schema).
 */
const isProjectIdRejected = (err: unknown) =>
  err instanceof Error &&
  /unrecognized key/i.test(err.message) &&
  err.message.includes('project_id');

/**
 * Calls a tool that takes `project_id`. Always tries with `project_id` first,
 * so a change to the server's scope while the view is open is picked up on the
 * next call. If a scoped server rejects it, this retries without `project_id`
 * only when `targetsScopedProject` says the requested project is the one the
 * server is scoped to. Otherwise it throws `ScopedServerError` rather than act
 * on the wrong project.
 *
 * `onScope` reports, per call, whether the server turned out to be scoped.
 */
export async function callProjectTool<T>(
  app: App,
  name: string,
  projectId: string,
  args: Record<string, unknown> = {},
  {
    targetsScopedProject = false,
    onScope,
  }: {
    targetsScopedProject?: boolean;
    onScope?: (scoped: boolean) => void;
  } = {}
): Promise<T> {
  let result: T;
  try {
    result = await callTool<T>(app, name, { ...args, project_id: projectId });
  } catch (err) {
    if (!isProjectIdRejected(err)) throw err;
    onScope?.(true);
    if (!targetsScopedProject) throw new ScopedServerError();
    return callTool<T>(app, name, args);
  }
  onScope?.(false);
  return result;
}
