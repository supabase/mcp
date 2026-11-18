import type { App } from '@modelcontextprotocol/ext-apps';
import type { MouseEvent, SyntheticEvent } from 'react';
import { type Politeness, useAnnounce } from './Announcer';
import { callTool } from './call-tool';
import { CopyField } from './CopyField';
import { ChevronIcon, ExternalLinkIcon, SpinnerIcon } from './icons';
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
 * Connection details: fetched the first time the disclosure opens, then kept
 * here across collapse and expand (whether it is open is separate state, owned
 * by the `<details>` element). If they can't be fetched (the
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

/** Prefer an enabled publishable key, then the legacy `anon` key. */
function pickKey(keys: Key[]): string | undefined {
  const enabled = keys.filter((k) => !k.disabled);
  return (
    enabled.find((k) => k.type === 'publishable') ??
    enabled.find((k) => k.type === 'legacy' && k.name === 'anon') ??
    enabled.find((k) => k.type === 'legacy')
  )?.api_key;
}

/** The project's page in the Supabase dashboard (Studio). */
const studioUrl = (projectRef: string) =>
  `https://supabase.com/dashboard/project/${encodeURIComponent(projectRef)}`;

/**
 * Actions for a project that is ready: open it in Studio, and a collapsible
 * disclosure with its connection details. UI-only: nothing here is sent to the
 * model's context.
 *
 * Calls always pass `projectRef` as `project_id`. A server scoped to another
 * project (e.g. a branch's parent) would reject it, so callers pass
 * `canReachProject` false then.
 */
export function ReadyActions({
  app,
  projectRef,
  canReachProject = true,
  canOpenLinks = true,
}: {
  app: App;
  projectRef: string;
  /**
   * False when no tool call can reach this project: the server is scoped to
   * another project, or the host can't proxy tool calls. Connection details
   * then go straight to the dashboard link.
   */
  canReachProject?: boolean;
  /**
   * False when the host can't open links. A sandboxed view can't open them
   * itself, so the Open in Studio button is hidden and connection details
   * offer the Studio link to copy instead.
   */
  canOpenLinks?: boolean;
}) {
  const announce = useAnnounce();
  const projectUrl = studioUrl(projectRef);
  const dashboardUrl = `${projectUrl}?showConnect=true`;

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
            callTool<{ url: string }>(app, 'get_project_url', {
              project_id: projectRef,
            }),
            callTool<{ keys: Key[] }>(app, 'get_publishable_keys', {
              project_id: projectRef,
            }),
          ])
            .then(([{ url }, { keys }]) => {
              const key = pickKey(keys);
              send(
                key ? { type: 'loaded', url, key } : { type: 'unavailable' }
              );
            })
            .catch(() => send({ type: 'unavailable' }));
          return;
      }
    }
  );

  // Sandboxed views can't navigate, so the host opens the link. `href` keeps
  // it a real link for assistive tech, copying and middle-click.
  function openLink(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    void app.openLink({ url: event.currentTarget.href });
  }

  // Only opening requests details; the machine ignores requests once it has
  // left `idle`, so re-opening never refetches.
  function onToggle(event: SyntheticEvent<HTMLDetailsElement>) {
    if (event.currentTarget.open) {
      sendConnection({ type: 'request', canFetch: canReachProject });
    }
  }

  return (
    <div className="ready-actions">
      {canOpenLinks && (
        <div data-slot="actions">
          <a
            className="button"
            data-size="sm"
            href={projectUrl}
            onClick={openLink}
          >
            <ExternalLinkIcon />
            Open in Studio
          </a>
        </div>
      )}
      <details data-slot="connection" onToggle={onToggle}>
        <summary>
          Connection details
          <ChevronIcon />
        </summary>
        <div data-slot="panel">
          {connection.status === 'loading' && (
            <div data-slot="loading">
              <SpinnerIcon />
              <Message>Loading connection details…</Message>
            </div>
          )}
          {connection.status === 'dashboard' &&
            (canOpenLinks ? (
              <a
                data-slot="dashboard-link"
                href={dashboardUrl}
                onClick={openLink}
              >
                Open in Studio
                <ExternalLinkIcon />
              </a>
            ) : (
              <CopyField label="Studio link" value={dashboardUrl} />
            ))}
          {connection.status === 'details' && (
            <>
              <CopyField label="Project URL" value={connection.url} />
              <CopyField label="Publishable key" value={connection.key} />
              {!canOpenLinks && (
                <CopyField label="Studio link" value={projectUrl} />
              )}
            </>
          )}
        </div>
      </details>
    </div>
  );
}
