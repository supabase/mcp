# Security Policy

Thank you for helping keep the Supabase MCP server and its users safe.

## Reporting a vulnerability

Please report suspected vulnerabilities through our HackerOne program:
<https://hackerone.com/supabase>. Please do not open public GitHub issues or
pull requests for security problems.

This repository contains the Supabase MCP (Model Context Protocol) server. It
lets AI assistants and agents work with Supabase projects through tools such as
running SQL, managing migrations and tables, deploying Edge Functions, reading
logs, and managing projects. The same code runs as the Supabase-hosted MCP
endpoint, and can also be run locally or embedded in your own server. We accept
reports for all of these, and we triage them differently (see "Hosted vs.
self-run" below).

## How MCP security works here

Two facts frame most reports about this project.

- **An MCP server acts with the access token it is given.** Whatever the token
  can do through the Supabase Management API, the server can do. Running SQL
  through the MCP server is the same level of access as the dashboard. The
  token, its scopes and the project it is limited to decide what is possible,
  not flags that a client sends.
- **The model is not a trust boundary.** Tool calls come from an AI model that
  can be influenced by whatever text it reads. We reduce that risk (for
  example, tool results are wrapped in untrusted-data boundaries), but prompt
  injection is a known limitation of every MCP setup, and clients are expected
  to ask the user to approve tool calls.

## What we consider a vulnerability

In general, we want to hear about anything that lets an attacker make the MCP
server do something its token, scope or configuration does not allow, expose a
credential, or reach beyond what the user approved: acting outside the project,
organization or read-only scope the server was started with, sending the user's
access token somewhere it should not go, or writing outside the location a tool
is meant to write to. The problem should be present in the hosted server or in
a default configuration of this one, and it should not need a token that
already grants the access you describe.

Examples of what this includes (these are illustrations, not a complete list):

- **Scope and permission enforcement.** A tool that works outside the project,
  organization or feature set the server was restricted to, or a read-only mode
  that can be turned off from a prompt or by a tool argument when it is
  enforced by the server's own configuration. Tools restricted to a scope must
  enforce it for every mutating tool, not only for list and create operations.
- **Credential exposure.** Tool parameters that are used to build request URLs
  or headers and can redirect the access token or other credentials to another
  host, and secrets that appear in tool output, logs or error messages.
- **Injection in the server's own queries and commands.** Unparameterized or
  unescaped input that reaches SQL or another interpreter in a way that goes
  beyond what the caller's token could already do.
- **Writes outside the intended location.** A tool parameter that lets a file be
  written, read or deleted outside the location the tool is meant to use. Show a
  file actually written to the attacker's chosen location.
- **Untrusted data reaching the model without the protections we apply.** Tool
  output that contains user data but is not wrapped in the untrusted-data
  boundary that comparable tools use.
- **Cross-tenant access.** One user's, organization's or project's resources
  being reachable through another user's session on the hosted server.

## What we do not consider a vulnerability

Reports that rely on the behavior below will normally be closed as
informative or not applicable.

**By design**

- **`execute_sql` runs arbitrary SQL.** It gives the same access as the SQL
  editor in the dashboard, to a user who is authorized through the access
  token. Reporting that it can run any statement, including writes, is not a
  vulnerability. Use read-only mode to restrict writes, and create an access
  token with the scope you want. Injection into another tool is not
  interesting when the same caller can already run arbitrary SQL through
  `execute_sql`.
- **Permissions come from the access token, not from request flags.** A
  parameter such as `read_only` that the client sends can always be omitted or
  set to false by the client, so it is not a security control. Show that the
  *token's* permissions or the server's own startup configuration can be
  bypassed.
- **Prompt injection in general.** Text in a database, a log or a web page can
  influence an AI model, and no one has a complete fix. A report must show a
  working end-to-end exploit through a realistic client that gains something
  the attacker is not allowed to have, and not just that a model followed
  instructions it found in data. If the attacker must already hold a privilege
  such as DDL access or function-edit rights to plant the payload, no new
  privilege is gained. Tool descriptions are written by the maintainers, and are
  not attacker-controlled input.
- **The cost confirmation step** is an awareness aid for the user. That its
  confirmation id can be predicted or supplied in advance does not defeat a
  security boundary: clients that ask for approval of tool calls cover this
  case, and the action only creates a resource on the user's own account.
- **The handler library does not provide authentication.** The package that lets
  you embed the server in an HTTP service leaves authentication, network
  binding and Origin or Host validation to the deployer, usually an upstream
  proxy. The README snippet shows the minimum code to create a handler, not a
  recommended production deployment. Self-hosted MCP is also disabled by
  default in the Supabase self-hosting setup, and the configuration explains the
  risk of enabling it. A report must be demonstrated against the documented
  setup.

**Prerequisites that make the attack pointless**

- The attacker needs the victim's access token, or a token that already grants
  the access described.
- The attacker needs high privileges in the database or the project to plant
  the payload.
- The attacker needs a user to disable tool approval in their MCP client. That
  user has accepted that tools can do risky things on their behalf.

**Reports that are not evidence of a flaw**

- **A path-looking parameter that is used as a name or only sent to an API.**
  If the caller already holds a credential that can request the target route
  directly, or the server picks the real destination itself, a `../` in the
  parameter is not a traversal. Show a file written to an attacker-controlled
  location, not only that the string is accepted.
- **Findings on an old version.** Retest on the latest release.
- **Credentials from other people's repositories.** A token that a community
  member committed to their own repository belongs to them and not to
  Supabase. We notify the owner.
- **Automated scanner or LLM-judge output** with no working exploit, code that
  does not match the current repository, and reports that bundle several
  unverified findings.

## Out of scope for every Supabase asset

These are excluded program-wide (see also
<https://supabase.com/.well-known/security.txt>). They are repeated here so
you do not need to leave this repository to find them.

- Clickjacking on pages with no sensitive actions.
- Unauthenticated, logout and login CSRF.
- Attacks requiring MITM or physical access to a user's device.
- Attacks requiring social engineering.
- Any activity that could lead to the disruption of our service (DoS).
  This means volumetric attacks, load testing and flooding. A vulnerability in
  our code that lets an unprivileged attacker crash a service or exhaust
  resources for other users or tenants is in scope. Denial of service that only
  affects the attacker's own project, or that needs admin or owner privileges,
  is not.
- Content spoofing and text injection issues without showing an attack vector,
  or without being able to modify HTML/CSS.
- Email spoofing.
- Missing DNSSEC, CAA or CSP headers.
- Lack of Secure or HttpOnly flags on non-sensitive cookies.
- Dead links.
- User enumeration.

## Known and documented behavior

These are described in our documentation. Please check them before reporting.

- **Read-only mode** is the recommended way to limit an MCP session to reading
  data. See the README.
- **Tool results are wrapped in untrusted-data boundaries** that tell the model
  not to follow instructions in data. This lowers the chance of prompt
  injection but cannot remove it.
- **The hosted and the self-hosted MCP are different deployments.** Please
  state which one you tested.

## Hosted vs. self-run

We accept findings against the hosted server and the default configuration of
the server in this repository. We treat findings that need the operator to
misconfigure the deployment as lower severity, such as binding the handler to a
public interface without authentication, running it with a broad access token,
or disabling tool approval in their client. Label your report as described in
the next section.

## How to write a report that gets triaged quickly

- **Say what you tested, at the top of the report and in the title.** Use one of
  these labels, for example `[Hosted MCP] ...` in the title and a "Target" line
  at the start of the description:
  - **Hosted MCP server**: the Supabase-hosted endpoint at
    <https://mcp.supabase.com/mcp>, against an account and project you own.
  - **Self-run, default configuration**: the MCP server from this repository
    run as the README describes, using an access token you own. Include the
    package version or commit, the MCP client, and the flags you used
    (for example `--read-only`, `--project-ref`, `--features`).
  - **Custom deployment**: you embedded the handler library in your own server,
    changed the code, bound it to a public interface, or removed the proxy that
    supplies authentication. List what you changed and why. We triage these
    lower unless the setup is one we document.

  Please say which of the two server projects you tested. Reports that do not
  say which target they are about are slower to triage, and are often closed
  with a request to retest. A finding that works only on a custom deployment is
  not a finding against the hosted server.

- **Test a real setup.** Reproduce with a real MCP client and a project you own.
  Code reading alone is rarely enough. Static analysis findings need a working
  proof of concept, and the code you cite must match the current repository.
- **Give a short, runnable PoC.** The exact tool calls or requests, the client
  and model, and the output showing the impact. Include a cleanup note if your
  test creates or changes resources, and use your own project.
- **State the attacker's starting position and what the user approved.** What
  does the attacker control (text in a table, a tool argument, a leaked token)?
  What did the user have to do, such as approve a tool call? Reports that
  assume an existing high privilege, or a user who disabled approvals, are our
  most common reason to close.
- **Name the boundary you crossed.** Which project, organization, scope or
  permission could not be reached before? If nothing was crossed, it is
  probably a hardening suggestion.
- **Check the docs, this file and the current version first.** If the behavior
  is documented, explain why it still fails. Retest on the latest release.
- **Include versions.** The package version or commit, the server flags, and the
  MCP client.
- **One issue per report.** Link variants of the same root cause instead of
  filing each variant separately.
- **Do not send unreviewed AI output.** Reports that were not reproduced by a
  human and that ignore the documentation are closed. AI-assisted analysis is
  fine when you have verified the result.
- **Respond to follow-up questions.** Reports that go quiet after we ask for a
  reproduction are closed.

## Severity

We rate severity by realistic impact on a default deployment. Issues that need
prompt injection, a user to approve a tool call, or an existing privilege are
rated lower even when they are valid, and we may fix them as defense in depth.

## Testing and disclosure

These are our program-wide rules. They also apply to AI agents and automated
tools acting on your behalf.

**Testing**

- Do not run automated scanners against other customers' projects. Scanners can
  run up costs for our users, can disrupt services, and our own security
  systems cannot tell hostile reconnaissance from research. If you want to run
  an automated scanner, notify security@supabase.com first and run it only on
  your own Supabase project.
- Do not attack projects that belong to other customers.
- Do not take advantage of a vulnerability you find, for example by downloading
  more data than necessary to demonstrate it, or by deleting or modifying other
  people's data.

**Disclosure**

- Do not reveal the problem to others until we have researched and fixed it and
  informed affected customers.
- If you want to share your research publicly (a conference, a blog or any
  other public forum), send us a draft for review and approval at least 30 days
  before the publication date. Do not include data about Supabase customer
  projects, customers' data, or information about Supabase employees,
  contractors or partners.

**What we promise**

- We will respond to your report within 5 business days with our evaluation and
  an expected resolution date.
- If you have followed these instructions, we will not take legal action against
  you in regard to the report.
- We will handle your report with strict confidentiality and will not pass on
  your personal details to third parties without your permission.
- We will keep you informed of our progress.
- In public information about the problem, we will name you as the discoverer
  unless you prefer otherwise.
