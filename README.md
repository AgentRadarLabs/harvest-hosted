# Harvest Hosted

This is the official first-party distribution repository for Harvest AI at
https://tryharvest.ai. Install the Harvest skill so your existing agent can join
and participate in a Google Meet that you are authorized to access.

## Primary setup

Create the credential first:

1. Open https://tryharvest.ai/agents and sign in with Google.
2. Create an agent and save its one-time credential.
3. Expose it only to the installer process as `HARVEST_TOKEN`.

Install the pinned tarball served by Harvest for your runtime:

```sh
npx --yes https://tryharvest.ai/client-harvest-hosted-0.2.5.tgz --runtime codex
npx --yes https://tryharvest.ai/client-harvest-hosted-0.2.5.tgz --runtime claude-code
```

Run only the command for your runtime. The installer writes the skill and MCP
bridge. It does not create an account, access a mailbox, or issue a credential.

## Developer API

For a product integration, first get written permission from Harvest AI under
the [license](LICENSE), then sign in at https://tryharvest.ai/docs/api and create
an account developer key. Keep `HARVEST_DEV_KEY` on your server. It grants
account-wide agent management; the per-agent `HARVEST_TOKEN` is for the MCP
meeting connection only.

```js
import { HarvestApi } from 'harvest-hosted/api';

const api = new HarvestApi({ apiKey: process.env.HARVEST_DEV_KEY });
const { voices, identities, backdrops } = await api.catalog({ locale: 'ru-RU', tag: 'friendly' });
const requestKey = crypto.randomUUID(); // Persist this key before sending; reuse it on retry.
const { agent, credential } = await api.createAgent({
  display_name: 'Researcher',
  identity_id: identities[0].identity_id,
  avatar_slug: identities[0].avatar_slug,
  color: '#ff6a45',
  voice_preset: voices[0].voice_preset,
  backdrop_slug: backdrops.find((slug) => slug === 'grid') ?? backdrops[0],
}, { idempotencyKey: requestKey });
// Save credential.token once and give it only to that agent's runtime.
await api.configureAgent(agent.agent_id, {
  display_name: 'Outreach Researcher',
  identity_id: identities[0].identity_id,
  avatar_slug: identities[0].avatar_slug,
  color: '#8b5cf6',
  voice_preset: voices[0].voice_preset,
});
```

The API also exposes `agents()`, `agent(id)`, `issueAgentToken(id)`, and
`revokeAgentToken(id, credentialId)`. Rotating the developer key invalidates its
previous value immediately. The pinned 0.2.5 hosted installer above predates
this API; npm releases are versioned separately.

Reuse the same `idempotencyKey` when retrying a timed-out create request. The
first request can still succeed; a repeated key then returns 409 and never
returns the first one-time token again. Check `agents()` and issue a fresh token
with `issueAgentToken(id)` if you lost the original response.

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
installation so the new tools load. The installer never prints API keys. If an installed
file differs, installation stops; remove or back up an old installation
yourself before replacing it.

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
npx --yes https://tryharvest.ai/client-harvest-hosted-0.2.5.tgz claude
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

## Requirements

- Node.js 18 or newer
- A Harvest API token intentionally supplied in `HARVEST_TOKEN`, or a
  previously saved credential
- The selected runtime CLI (`codex` or `claude`) on `PATH`; the installer
  configures the Harvest MCP endpoint automatically

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
