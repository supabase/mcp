# AgentCat OTLP preview setup

This branch uses the AgentCat SDK without an AgentCat account. It exports OpenTelemetry traces only when `SUPABASE_AGENTCAT_OTLP_ENDPOINT` is set on the local HTTP entry. Hosted, stdio, and unconfigured local HTTP behavior stays unchanged.

The integration exports tool names, timing, client metadata, success state, a one-way SHA-256 actor ID derived from the Supabase access token, and the agent-provided intent. It removes tool arguments, responses, raw errors, IP addresses, and identifying metadata. AgentCat injects `context` as a required string on every tool while tracking is enabled, then strips it before the tool handler runs. Do not put SQL, project references, user data, tokens, error messages, or tool output in that field.

## Start a local collector

Any OTLP/HTTP collector on a loopback hostname works; remote endpoints are rejected. This Jaeger command keeps data in memory and exposes its UI at `http://127.0.0.1:16686`:

```bash
docker run --rm --name supabase-agentcat-jaeger \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:1.62.0
```

## Start the package preview

Use a non-production Supabase project and a personal access token with the minimum required permissions.

```bash
export SUPABASE_AGENTCAT_OTLP_ENDPOINT='http://127.0.0.1:4318'
export SUPABASE_ACCESS_TOKEN='sbp_...'
npx https://pkg.pr.new/@supabase/mcp-server-supabase@<sha> --http
```

PowerShell:

```powershell
$env:SUPABASE_AGENTCAT_OTLP_ENDPOINT = 'http://127.0.0.1:4318'
$env:SUPABASE_ACCESS_TOKEN = 'sbp_...'
npx https://pkg.pr.new/@supabase/mcp-server-supabase@<sha> --http
```

The server prints `AgentCat OTLP analytics enabled.` and listens at `http://127.0.0.1:3111/mcp`. Configure an MCP client with the token in the header and keep the endpoint read-only:

```json
{
  "mcpServers": {
    "supabase-agentcat-preview": {
      "type": "http",
      "url": "http://127.0.0.1:3111/mcp?project_ref=<non-production-project-ref>&read_only=true",
      "headers": {
        "Authorization": "Bearer ${SUPABASE_ACCESS_TOKEN}",
        "X-Supabase-AgentCat-Session-Id": "seed-001"
      }
    }
  }
}
```

Client environment-variable interpolation differs. Use the client's secret store when `${SUPABASE_ACCESS_TOKEN}` is not supported. Never commit the token.

## Generate seed sessions

`seed.json` contains prompts only. It has no expected tools, classifications, metrics, or conclusions.

```bash
jq -r '.sessions[].messages[].content' packages/mcp-server-supabase/examples/agentcat/seed.json
```

Replace `<non-production-project-ref>`. For each `sessions[]` item, set `X-Supabase-AgentCat-Session-Id` to its `id`, reconnect the client, and run its messages in one chat. Do not approve mutations if a client proposes one.

The session header is hashed before export and never appears in the trace. Without it, this stateless preview groups calls from the same token into fixed 30-minute buckets, which can merge concurrent tasks or split a task across a bucket boundary. A transport connection is not an analytics session.

## Inspect and report

1. Open Jaeger and select the `supabase` service.
2. Review traces by tool name, status, duration, client, intent, and session ID.
3. Export the raw traces before stopping the in-memory collector:

   ```bash
   curl --fail --get 'http://127.0.0.1:16686/api/traces' \
     --data-urlencode 'service=supabase' \
     --data-urlencode 'limit=1000' \
     --output /tmp/supabase-agentcat-traces.json
   ```

4. Build reports from that raw export. Record the date range, filters, denominators, and session-grouping caveat. Keep exports and generated reports outside the repository.
5. Separate observed data from interpretation. Do not present the synthetic seed as production behavior.

Stop both processes with `Ctrl+C`, then clear the local variables. The SDK appends structural metadata to `~/agentcat.log` while tracking is enabled; inspect and remove that file after the experiment.

```bash
unset SUPABASE_AGENTCAT_OTLP_ENDPOINT SUPABASE_ACCESS_TOKEN
rm -f ~/agentcat.log
```
