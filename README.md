# Harvest Hosted

This is the official first-party distribution repository for Harvest AI at
https://tryharvest.ai. Install the Harvest skill so your existing agent can join
and participate in a Google Meet that you are authorized to access.

For product integrations, follow the [partner quickstart](docs/partner-quickstart.md): install, join, hear/speak, account API and capacity contracts.

## Primary setup

Create the credential first:

1. Open https://tryharvest.ai/agents and sign in with Google.
2. Create an agent and save its one-time credential.
3. Expose it only to the installer process as `HARVEST_TOKEN`.

Install the pinned tarball served by Harvest for your runtime:

```sh
npx --yes https://tryharvest.ai/client-harvest-hosted-0.2.8.tgz --runtime codex
npx --yes https://tryharvest.ai/client-harvest-hosted-0.2.8.tgz --runtime claude-code
```

Run only the command for your runtime. The installer writes the skill and MCP
bridge. It does not create an account, access a mailbox, or issue a credential.
If upgrading an unmodified 0.2.5, 0.2.6 or 0.2.7 installation, append `--upgrade`.
The installer checks published-file hashes, backs up the old skill, and refuses
unknown or edited files. Restart your runtime to load the new bridge.

## Developer API

For a product integration, first get written permission from Harvest AI under
the [license](LICENSE), then sign in at https://tryharvest.ai/docs/api and create
an account developer key. Keep `HARVEST_DEV_KEY` on your server. It grants
account-wide agent management; the per-agent `HARVEST_TOKEN` is for the MCP
meeting connection only.

```js
import { HarvestApi } from 'harvest-hosted/api';

const api = new HarvestApi({ apiKey: process.env.HARVEST_DEV_KEY });
const { voices, identities, backdrops } = await api.catalog();
const voice = voices[0];
if (!voice) throw new Error('No voice available in the current catalog');
const requestKey = crypto.randomUUID(); // Persist this key before sending; reuse it on retry.
const { agent, credential } = await api.createAgent({
  display_name: 'Researcher',
  identity_id: identities[0].identity_id,
  avatar_slug: identities[0].avatar_slug,
  color: '#ff6a45',
  voice_preset: voice.voice_preset,
  backdrop_slug: backdrops.find((slug) => slug === 'grid') ?? backdrops[0],
}, { idempotencyKey: requestKey });
// Save credential.token once and give it only to that agent's runtime.
await api.configureAgent(agent.agent_id, {
  display_name: 'Outreach Researcher',
  identity_id: identities[0].identity_id,
  avatar_slug: identities[0].avatar_slug,
  color: '#8b5cf6',
  voice_preset: voice.voice_preset,
});
```

The API also exposes `agents()`, `agent(id)`, `issueAgentToken(id)`, and
`revokeAgentToken(id, credentialId)`. Rotating the developer key invalidates its
previous value immediately. The pinned hosted installer and npm package are
versioned separately; publishing 0.3.0 does not change the hosted URL.
Creating an agent with a developer key requires an explicit `voice_preset` from
the current catalog. The server decides which voice IDs are available.

Reuse the same `idempotencyKey` when retrying a timed-out create request. The
first request can still succeed; a repeated key then returns 409 and never
returns the first one-time token again. Check `agents()` and issue a fresh token
with `issueAgentToken(id)` if you lost the original response.
For rate limits, catch an error with `status === 429` and wait its
`retryAfterSeconds` before retrying.

Scheduled sessions are a source preview until the app and gateway changes are
deployed and the production timing test passes. They use the existing MCP
meeting mode. Connect the agent's Claude Code Channels brain before it joins;
the first brain job adopts the same agent's scheduled body. Other MCP clients
still need the existing explicit `join_meeting` adoption before bounded replay.
The developer key
must have issued a credential for that agent, so usage belongs to the same key.
The meeting brief is bounded handoff context, not enforced speech guardrails.

```js
const { session } = await api.join(agent.agent_id, {
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  joinAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // Optional; within 30 days.
  lobbyTimeoutSeconds: 600, // Optional; default 600, range 1..3600 seconds.
  brief: 'Review the saved plan when addressed by name.',
});
const current = await api.session(agent.agent_id, session.session_id);
if (current.session.state === 'waiting_room') {
  console.log('Waiting for host to admit');
}
await api.cancel(agent.agent_id, session.session_id);
```

Omit `joinAt` for an immediate join. Save `session_id`: scheduling acceptance
does not mean admission, and cancellation can remain `cancel_requested` until
the body stops. A lobby timeout ends as `not_admitted`; waiting-room time is
excluded from billable meeting minutes. The client never automatically retries
a join or cancellation. If a join response is lost, inspect the account-owned
session list with `api.sessions(agent.agent_id)` before creating another session.

### Webhooks and artifacts (source preview)

These methods require matching app and gateway releases plus runtime acceptance.
The pinned 0.2.8 installer above does not establish support for this source preview.
Keep the developer key and each webhook's one-time secret on your server.

```js
import { HarvestApi, verifyWebhookSignature } from 'harvest-hosted/api';

const api = new HarvestApi({ apiKey: process.env.HARVEST_DEV_KEY });
const { subscription, secret } = await api.createWebhook(
  'https://your-server.example/harvest-events',
  ['session.waiting_room', 'session.in_call', 'session.failed', 'artifacts.ready'],
);
// Save subscription.id and secret privately before returning from setup.
const { webhooks } = await api.webhooks();
const { deliveries } = await api.webhookDeliveries(subscription.id);
// After artifacts.ready, use its payload.session_id, not a meeting slot or operation ID:
// const artifacts = await api.artifacts(envelope.payload.session_id);
// await api.deleteWebhook(subscription.id); // Deactivates future event enqueueing.
```

Inside your existing JSON receiver, `envelope` is the parsed request body and
`savedSecret` is the secret stored during creation:

```js
if (!verifyWebhookSignature(envelope, savedSecret)) {
  return new Response('Invalid webhook signature', { status: 401 });
}
// Validate the subscribed event and timestamp, then commit to your durable inbox.
// Acknowledge with 2xx only after that commit succeeds, including stored duplicates.
```

Endpoints must use public HTTPS with port 443 and no URL credentials. Each account
can have two active endpoints; duplicate active endpoint URLs are rejected.

The signature is in the JSON body. Its five envelope fields are `event`,
`idempotency_key`, `occurred_at`, `payload`, and `signature`. The helper verifies
HMAC-SHA256 over the first four fields using canonical JSON and a Base64 signature;
pass the original secret string, not a decoded secret, and do not sign raw HTTP
bytes or look for a signature header. Session lifecycle payloads contain
`meeting_url` and `operation_id`. `artifacts.ready` carries `payload.session_id`.
Only the first four envelope fields are authenticated; ignore extra top-level fields.

Verify the signature first, then check the event is one you subscribed to. In a
durable inbox, atomically insert using `(subscription.id, idempotency_key)` as the
unique key before acknowledging with 2xx. An already stored duplicate should also
receive 2xx. Process that inbox separately so a delivery retry cannot repeat the
same action. The verification helper checks the signature and envelope shape; it
does not deduplicate events, enforce timestamps, or perform your business action.

`occurred_at` is the original event's ISO timestamp, retained on retries, not a
fresh delivery timestamp. Reject invalid timestamps and choose a permitted future
clock skew for your receiver. A blanket short past-age cutoff can reject legitimate
delayed deliveries after an outage. Retain deduplication records for as long as your
receiver accepts old events. Do not treat arrival order as event order.

Current gateway defaults allow five attempts, with exponential retry delays starting
at one second. HTTP 408, 425, 429, 5xx and transport failures are retryable; other
non-2xx responses become `dead_letter`. History reports `queued`, `delivered` or
`dead_letter`, with `attempts`, `next_attempt_at`, and optional `status`/`last_error`.
History is read-only; this SDK does not replay a dead letter. Deactivation does not
cancel already queued deliveries. The client never retries webhook mutations
automatically; after a lost creation response, inspect `webhooks()` before creating
another endpoint. The secret is returned only on creation, not recovered by listing.

Accepted subscription events are `meeting.completed`, `transcript.final`,
`participant.joined`, `participant.left`, `chat.message`, `session.joining`,
`session.waiting_room`, `session.in_call`, `session.left`, `session.failed`,
`speech.started`, `speech.completed`, `participant_command`, and `artifacts.ready`.
An accepted subscription is not proof that its event producer is deployed.
Webhooks are integration notifications; the original Claude Code brain still uses
native Channels. Artifact `processing` or `pending` does not mean ready, and
native text marked `generated` with `delivery: "unverified"` is not proof of heard speech.

## As an agent plugin

This repository is also a plugin in the [Agent Plugins](https://agent-plugins.org)
1.0.0 layout: `plugin.json`, `mcp.json`, and the skill under `skills/harvest/`. A
client that supports the standard can load the clone as-is instead of running the
installer. It starts the same local bridge and reads the same privately saved
credential, so no token is ever written into plugin configuration.

The installer copies `SKILL.md`, its fail-closed registration helpers,
and a thin local MCP bridge. It registers that bridge automatically for both
Codex and Claude Code. The bridge reads the privately saved credential at
runtime, so it never appears in runtime configuration or CLI arguments; it forwards channel
events and adds local-only participant-page tools while all meeting policy
remains on the hosted MCP server. Restart the selected runtime once after
installation so the new tools load. The installer never prints API keys. Without
`--upgrade`, a differing installed file stops installation; with it, only known
published files are backed up and replaced. Edited files still stop installation.

**In Claude Code, start it this way. This is the connection, not an
enhancement:**

```sh
harvest-hosted claude
```

That is the same thing as starting Claude yourself with the scope:

```sh
claude --dangerously-load-development-channels server:harvest-hosted
```

The launcher forwards everything after `claude` untouched, runs in the
directory you are already in, and exits with Claude's own exit code:

```sh
harvest-hosted claude --model opus -p "join the meeting and take notes"
```

Pinned, without installing anything:

```sh
npx --yes https://tryharvest.ai/client-harvest-hosted-0.2.8.tgz claude
```

It puts no credential on the command line — authorization stays in the MCP
headers helper — and it changes no global configuration.

Without that flag no channel event ever arrives, and the agent falls back to
polling `next_utterance`. Polling works, but it hears the room a beat late and
answers into a gap that has already closed — which reads to everyone in the
call as an agent that is slow rather than one that is listening. Treat the
flag as part of installation and put it in whatever script or alias starts the
agent, so nobody has to remember it.

Other MCP clients can run the installed `channel-bridge.mjs` as a normal stdio
server. When channel notifications do not wake model turns, use the bounded
`replay_meeting_events(wait_secs)` reader for transcripts and other meeting
events if the hosted server exposes it; use `next_utterance` on older servers.

Claude Code is currently the only supported runtime with a documented
in-process Harvest push path. Codex receives the same MCP tools through the
automatically registered bridge but uses a bounded MCP reader while automatic
wake of an already-open Codex task remains unverified.

## Agent host installs (source preview)

The six new installers and native manifests below are source changes, not part
of the pinned 0.2.8 tarball above. After this source change is merged, obtain one
authorized checkout:

```sh
git clone https://github.com/AgentRadarLabs/harvest-hosted.git
cd harvest-hosted
```

For a draft PR, check out its reviewed commit instead of assuming main contains
it. Use Node 18+ to run `node scripts/install.mjs --runtime HOST`. Do not
pass these new runtime names to the older published tarball. The installer
copies the same bridge and skill, preserves unrelated settings, and refuses a
competing Harvest entry or edited installed file. Restart the host afterwards.

All eight hosts use `https://tryharvest.ai/mcp` through the existing stdio
bridge. The bridge reads `~/.harvest-hosted/config.json` at runtime, with
`HARVEST_TOKEN` taking precedence. Import the owner-provided credential once:

```sh
node scripts/register.mjs import-env
node scripts/register.mjs probe
```

The token stays in the private config. No manifest contains bearer headers or
credentials. Verify the host lists Harvest tools before joining; an installation
receipt alone does not prove that a client loaded them.

| Host | Install | Meeting input |
| --- | --- | --- |
| Claude Code | Existing installer + `harvest-hosted claude` | Native Channels with documented launch scope |
| Codex | Existing installer | Bounded `replay_meeting_events` |
| Cursor | User MCP/skill or local plugin | Bounded `replay_meeting_events` |
| Gemini CLI | User MCP/skill or extension | Bounded `replay_meeting_events` |
| Windsurf / Devin Cascade | User MCP/skill | Bounded `replay_meeting_events` |
| GitHub Copilot CLI | User MCP/skill | Bounded `replay_meeting_events` |
| Junie CLI / IDE | User MCP/skill | Bounded `replay_meeting_events` |
| OpenClaw | Skill + native MCP registry | Bounded `replay_meeting_events` |

Only Claude has a verified in-process Channels wake path. Other clients must
keep one bounded reader in flight as described in the skill, preserve its
cursors, and handle gaps honestly. A notification or changed tool catalog is
not a model-turn wake. Native same-Claude/Live delegation remains the existing
Claude path; these installers do not create another body or voice bridge.

### Claude Code

```sh
node scripts/install.mjs --runtime claude-code
harvest-hosted claude
```

For a source checkout without a global binary, run
`node scripts/install.mjs claude`. Alternatively, the repository now exposes
a native marketplace:

```text
/plugin marketplace add AgentRadarLabs/harvest-hosted
/plugin install harvest@harvest
```

Use one installation route per client to avoid duplicate MCP servers. The
marketplace installs tools and the skill; plugin installation alone does not
prove Channels scope. Use the existing user-scoped installer and launcher for
the verified `server:harvest-hosted` Channels route.

### Codex

```sh
node scripts/install.mjs --runtime codex
codex mcp get harvest-hosted --json
```

Restart Codex and confirm the tools are available in the new task.

### Cursor

```sh
node scripts/install.mjs --runtime cursor
```

This installs `~/.cursor/skills/harvest/` and preserves unrelated entries in
`~/.cursor/mcp.json`. Reload Cursor and check Harvest in MCP settings.
Alternatively, copy the complete authorized checkout into
`~/.cursor/plugins/local/harvest/` and reload. Its native
`.cursor-plugin/plugin.json` uses `${CURSOR_PLUGIN_ROOT}`. Do not symlink to a
checkout outside the local plugins directory. Admin policy can block local
plugins. Cursor's public marketplace requires open-source plugins; Harvest's
proprietary license has not changed, so no marketplace approval is claimed.

### Gemini CLI

```sh
node scripts/install.mjs --runtime gemini
gemini mcp list
```

The user installer writes `~/.gemini/skills/harvest/` and merges the server into
`~/.gemini/settings.json`. Alternatively, from an authorized checkout:

```sh
gemini extensions link .
```

For Git-based distribution after the source is merged:
`gemini extensions install https://github.com/AgentRadarLabs/harvest-hosted`.
The extension discovers the existing `skills/` folder and starts the same
bridge using `${extensionPath}`. Choose either installer or extension, not both.

### Windsurf / Devin Cascade

```sh
node scripts/install.mjs --runtime windsurf
```

Current official Windsurf documentation redirects to Devin: this installer
uses `${XDG_CONFIG_HOME:-~/.config}/devin/skills/harvest/` and
`devin/mcp_config.json`. In Cascade, open the MCP configuration from its menu
and confirm this is the active file. Older Windsurf builds can use
`~/.codeium/windsurf/`; those builds need their native UI to register the same
installed bridge and skill location. Do not assume the renamed config is read
by an older build. Cascade has a 100-tool limit and organization allowlists.

### GitHub Copilot CLI

```sh
node scripts/install.mjs --runtime copilot
copilot mcp get harvest-hosted --json
```

This installs the skill into `~/.copilot/skills/harvest/` and registers a local
server in `~/.copilot/mcp-config.json` (`COPILOT_HOME` is respected). Select the
Harvest skill in Copilot CLI; existing workspace MCP entries can override the
user entry. This does not configure Copilot cloud agent or VS Code.

### Junie

```sh
node scripts/install.mjs --runtime junie
```

This installs `~/.junie/skills/harvest/` and the same local server into
`~/.junie/mcp/mcp.json`, shared by CLI and IDE. Use Junie's `/mcp` to confirm
it is Active, and `/harvest` to invoke the skill. Keep Junie's own tool approval
policy. A skills-only registry install would not register MCP or credentials.

### OpenClaw

```sh
node scripts/install.mjs --runtime openclaw
openclaw mcp add harvest-hosted --command node \
  --arg "$HOME/.openclaw/skills/harvest/channel-bridge.mjs" \
  --arg=--url --arg=https://tryharvest.ai/mcp
openclaw mcp show harvest-hosted --json
```

The installer installs the skill and helpers only. Register MCP once with
OpenClaw's native command so its JSON5 configuration and other servers are
preserved; an existing server must be reconciled in OpenClaw before adding.
If `OPENCLAW_STATE_DIR` is set, use that directory instead of `~/.openclaw`
in the bridge argument. `openclaw skills install ./skills/harvest --global`
is a skills-only alternative and does not install the bridge helpers or MCP.
The MCP registry is for eligible OpenClaw-managed runtimes; ACP does not accept
per-session MCP injection. Confirm tools in the intended runtime, not just the
registry. No permission or approval-mode flags are changed.

### Acceptance still required

Offline fixture checks cover installer merging, collisions, private credentials,
manifest path resolution, and actual MCP tool calls through an installed bridge
to a local fake gateway. They do not prove host wake, authentication to Harvest,
or audible Meet speech. Fresh Cursor and Gemini CLI must each join, speak with
independent listener recording plus matching transcript, and leave by following
this README. Public directory/gallery submissions remain separate and unrun.
See [host documentation and provenance](docs/agent-host-installs.md).

## Requirements

- Node.js 18 or newer
- A Harvest API token intentionally supplied in `HARVEST_TOKEN`, or a
  previously saved credential
- The selected host installed; Codex and Claude require their CLI on `PATH`.
  OpenClaw requires the additional native registration step above

## Credential setup

The preferred path is an agent credential created by the account owner and
provided to the agent process as `HARVEST_TOKEN`. The helper saves it with
private file permissions and probes MCP without printing the credential:

```sh
node ~/.codex/skills/harvest/register.mjs import-env
node ~/.codex/skills/harvest/register.mjs probe
```

The dashboard shows the API key once. The helper never prints it and reports
only the saved config path and non-secret fingerprint.

For Claude Code, the helper is under `~/.claude/skills/harvest/`. Set
`HARVEST_REGISTRATION_API_URL` only for an explicitly approved fake or staging
gateway. The helper never falls back to a demo, shared, internal, or another
user's token. The pinned npm package is the canonical installation path.

## Verify this checkout

```sh
npm test
```

The suite checks the public allowlist and package contents, then executes the
credential import and MCP handshake against an isolated fake endpoint and tests
the Claude installer with a fake CLI. Documentation wording is not treated as a
security proof.

## License

This is proprietary software, not open source. One local clone and unmodified
installation for authorized Harvest use are permitted. Copying, modification,
forking, redistribution, mirroring, derivative works, and commercial reuse are
otherwise prohibited. See [LICENSE](LICENSE).
