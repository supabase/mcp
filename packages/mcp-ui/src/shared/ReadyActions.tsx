import type { App } from '@modelcontextprotocol/ext-apps';
import type { MouseEvent } from 'react';
import { type Politeness, useAnnounce } from './Announcer';
import { callProjectTool } from './call-tool';
import { CopyField } from './CopyField';
import { Message } from './Message';
import { type Transition, useMachine } from './use-machine';

type Key = {
  api_key: string;
  name: string;
  type: 'legacy' | 'publishable';
  disabled?: boolean;
};

/** Shared effect: tell screen reader users what changed. */
type Announce = { type: 'announce'; message: string; politeness?: Politeness };

/**
 * Connection details: fetched once requested. If they can't be fetched (the
 * development tools are off, the server is scoped to another project, there's
 * no enabled key, or the call failed), a link to the dashboard's Connect
 * dialog is shown instead. Both outcomes are final.
 */
type Connection =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'details'; url: string; key: string }
  | { status: 'dashboard' };

type ConnectionEvent =
  /** `canFetch` false skips the fetch, which would only fail. */
  | { type: 'request'; canFetch: boolean }
  | { type: 'loaded'; url: string; key: string }
  | { type: 'unavailable' };

type ConnectionEffect = { type: 'fetchDetails' } | Announce;

const DASHBOARD_ANNOUNCEMENT: Announce = {
  type: 'announce',
  message: 'Connection details are in the dashboard',
};

const connectionTransition: Transition<
  Connection,
  ConnectionEvent,
  ConnectionEffect
> = (state, event) => {
  switch (event.type) {
    case 'request':
      if (state.status !== 'idle') return null;
      return event.canFetch
        ? { state: { status: 'loading' }, effects: [{ type: 'fetchDetails' }] }
        : { state: { status: 'dashboard' }, effects: [DASHBOARD_ANNOUNCEMENT] };
    // Results only land on a request that is still in flight.
    case 'loaded':
      return state.status === 'loading'
        ? {
            state: { status: 'details', url: event.url, key: event.key },
            effects: [
              { type: 'announce', message: 'Connection details shown' },
            ],
          }
        : null;
    case 'unavailable':
      return state.status === 'loading'
        ? { state: { status: 'dashboard' }, effects: [DASHBOARD_ANNOUNCEMENT] }
        : null;
  }
};

/** Ping: one `select 1` at a time; the last result stays until the next. */
type Ping =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; ms: number }
  | { status: 'error'; message: string };

type PingEvent =
  | { type: 'start' }
  | { type: 'succeeded'; ms: number }
  | { type: 'failed'; message: string };

type PingEffect = { type: 'ping' } | Announce;

const pingTransition: Transition<Ping, PingEvent, PingEffect> = (
  state,
  event
) => {
  switch (event.type) {
    case 'start':
      return state.status === 'running'
        ? null
        : {
            state: { status: 'running' },
            effects: [
              { type: 'announce', message: 'Pinging project' },
              { type: 'ping' },
            ],
          };
    case 'succeeded':
      return state.status === 'running'
        ? {
            state: { status: 'ok', ms: event.ms },
            effects: [
              { type: 'announce', message: `Reachable, ${event.ms} ms` },
            ],
          }
        : null;
    case 'failed':
      return state.status === 'running'
        ? {
            state: { status: 'error', message: event.message },
            effects: [
              {
                type: 'announce',
                message: event.message,
                politeness: 'assertive',
              },
            ],
          }
        : null;
  }
};

/** Prefer an enabled publishable key, then the legacy `anon` key. */
function pickKey(keys: Key[]): string | undefined {
  const enabled = keys.filter((k) => !k.disabled);
  return (
    enabled.find((k) => k.type === 'publishable') ??
    enabled.find((k) => k.type === 'legacy' && k.name === 'anon') ??
    enabled.find((k) => k.type === 'legacy')
  )?.api_key;
}

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/**
 * Actions for a project that is ready: show its connection details and ping
 * it. UI-only: nothing here is sent to the model's context.
 *
 * Calls always pass `projectRef` and never fall back to a scoped server's own
 * project, which is never the one this view created: a scoped server makes the
 * connection details fall back to the dashboard and the ping fail.
 */
export function ReadyActions({
  app,
  projectRef,
  canReachProject = true,
}: {
  app: App;
  projectRef: string;
  /**
   * False when the server is known to be scoped to another project (e.g. a
   * branch's parent), so no tool can reach this one: ping is hidden and
   * connection details go straight to the dashboard link.
   */
  canReachProject?: boolean;
}) {
  const announce = useAnnounce();
  const dashboardUrl = `https://supabase.com/dashboard/project/${projectRef}?showConnect=true`;

  const [connection, sendConnection] = useMachine(
    connectionTransition,
    { status: 'idle' },
    (effect, send) => {
      switch (effect.type) {
        case 'announce':
          announce(effect.message, effect.politeness);
          return;
        case 'fetchDetails':
          Promise.all([
            callProjectTool<{ url: string }>(
              app,
              'get_project_url',
              projectRef
            ),
            callProjectTool<{ keys: Key[] }>(
              app,
              'get_publishable_keys',
              projectRef
            ),
          ]).then(
            ([{ url }, { keys }]) => {
              const key = pickKey(keys);
              send(
                key ? { type: 'loaded', url, key } : { type: 'unavailable' }
              );
            },
            () => send({ type: 'unavailable' })
          );
          return;
      }
    }
  );

  const [ping, sendPing] = useMachine(
    pingTransition,
    { status: 'idle' },
    (effect, send) => {
      switch (effect.type) {
        case 'announce':
          announce(effect.message, effect.politeness);
          return;
        case 'ping': {
          const start = performance.now();
          callProjectTool(app, 'execute_sql', projectRef, {
            query: 'select 1',
          }).then(
            () =>
              send({
                type: 'succeeded',
                ms: Math.round(performance.now() - start),
              }),
            (err) => send({ type: 'failed', message: errorMessage(err) })
          );
          return;
        }
      }
    }
  );

  // Sandboxed views can't navigate, so the host opens the link. `href` keeps
  // it a real link for assistive tech, copying and middle-click.
  function openDashboard(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    void app.openLink({ url: dashboardUrl });
  }

  return (
    <div className="ready-actions">
      <div data-slot="actions">
        <button
          type="button"
          className="primary"
          onClick={() =>
            sendConnection({ type: 'request', canFetch: canReachProject })
          }
          disabled={connection.status !== 'idle'}
        >
          Connection details
        </button>
        {canReachProject && (
          <button
            type="button"
            onClick={() => sendPing({ type: 'start' })}
            disabled={ping.status === 'running'}
          >
            {ping.status === 'running' ? 'Pinging…' : 'Ping project'}
          </button>
        )}
        {ping.status === 'ok' && (
          <span data-slot="ping-result">
            <span data-tone="success">Reachable</span>, {ping.ms} ms
          </span>
        )}
      </div>
      {ping.status === 'error' && (
        <Message tone="error">{ping.message}</Message>
      )}
      {connection.status === 'dashboard' && (
        <a href={dashboardUrl} onClick={openDashboard}>
          Open connection details in the dashboard
        </a>
      )}
      {connection.status === 'details' && (
        <div data-slot="details">
          <CopyField label="Project URL" value={connection.url} />
          <CopyField label="Publishable key" value={connection.key} />
        </div>
      )}
    </div>
  );
}
