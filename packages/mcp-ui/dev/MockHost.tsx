/**
 * A minimal MCP Apps host for developing views with `pnpm dev`, without a
 * real MCP server or Supabase account.
 *
 * It uses the SDK's own host side (`AppBridge`), so views talk to it exactly
 * as they would to Claude or ChatGPT. Tool input and results come from
 * `fixtures.ts`.
 *
 * Add `?source=dist` to load the built single-file HTML from `dist/` (run
 * `pnpm build` first) instead of the dev source, to check what actually ships.
 */
import {
  AppBridge,
  PostMessageTransport,
} from '@modelcontextprotocol/ext-apps/app-bridge';
import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Fixture, fixtures } from './fixtures';

type Theme = 'light' | 'dark';

const params = new URLSearchParams(location.search);
const useBuiltHtml = params.get('source') === 'dist';
const views = Object.keys(fixtures);

function MockHost() {
  const [view, setView] = useState(params.get('view') ?? views[0]!);
  const [theme, setTheme] = useState<Theme>(
    params.get('theme') === 'dark' ? 'dark' : 'light'
  );
  const [log, setLog] = useState<string[]>([]);

  // Real hosts declare their color-scheme. Browsers paint an opaque backdrop
  // behind an iframe whose color-scheme differs from its embedder's, which
  // would hide the view's transparent background.
  useEffect(() => {
    document.documentElement.style.colorScheme = theme;
    document.body.style.background = theme === 'dark' ? '#1c1c1c' : '';
    document.body.style.color = theme === 'dark' ? '#eee' : '';
  }, [theme]);

  const fixture = fixtures[view];
  if (!fixture) throw new Error(`No fixture for view "${view}"`);

  return (
    <>
      <header>
        <strong>Mock MCP Apps host</strong>
        <label>
          View{' '}
          <select value={view} onChange={(e) => setView(e.target.value)}>
            {views.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </label>
        <label>
          Theme{' '}
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
          >
            <option>light</option>
            <option>dark</option>
          </select>
        </label>
      </header>
      <ViewFrame
        // A new view or theme means a new host session, as in a real chat.
        key={`${view}:${theme}`}
        view={view}
        theme={theme}
        fixture={fixture}
        onLog={(line) => setLog((lines) => [...lines, line])}
        onReset={() => setLog([])}
      />
      <pre id="log">{log.join('\n')}</pre>
    </>
  );
}

function ViewFrame({
  view,
  theme,
  fixture,
  onLog,
  onReset,
}: {
  view: string;
  theme: Theme;
  fixture: Fixture;
  onLog: (line: string) => void;
  onReset: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const iframe = iframeRef.current!;
    const log = (message: string) =>
      onLog(`${new Date().toLocaleTimeString()} ${message}`);
    let cancelled = false;

    onReset();

    const bridge = new AppBridge(
      null,
      { name: 'mcp-ui-mock-host', version: '0.0.0' },
      { serverTools: {} },
      { hostContext: { theme } }
    );
    bridge.onsizechange = ({ height }) => {
      if (height) iframe.height = String(height);
    };
    bridge.oncalltool = async ({ name, arguments: args = {} }) => {
      log(`view called ${name} ${JSON.stringify(args)}`);
      return fixture.callTool(args);
    };
    bridge.oninitialized = async () => {
      log(`view initialized, sending ${fixture.toolName} input and result`);
      await bridge.sendToolInput({ arguments: fixture.input });
      await bridge.sendToolResult(fixture.callTool(fixture.input));
    };

    // Connect before loading the view, so its first message isn't missed.
    (async () => {
      await bridge.connect(
        new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!)
      );
      if (cancelled) return;

      if (useBuiltHtml) {
        const path = `dist/src/views/${view}/index.html`;
        const response = await fetch(`/${path}`);
        if (!response.ok) throw new Error(`${path} not found, run pnpm build`);
        if (!cancelled) iframe.srcdoc = await response.text();
      } else {
        iframe.src = `/src/views/${view}/index.html`;
      }
    })();

    // StrictMode runs effects twice in development. Closing the first bridge
    // keeps the view from getting two connections and two results.
    return () => {
      cancelled = true;
      void bridge.close();
    };
    // Runs once per mount: a new view or theme re-mounts via `key`.
  }, []);

  return (
    <div id="frame-wrapper">
      <iframe
        ref={iframeRef}
        title={view}
        sandbox="allow-scripts allow-same-origin"
        height={320}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MockHost />
  </StrictMode>
);
