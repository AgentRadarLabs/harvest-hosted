# Harvest Hosted

This is the official first-party distribution repository for Harvest AI at
https://tryharvest.ai. Install the Harvest skill so your existing agent can join
and participate in a Google Meet that you are authorized to access.

## Primary setup

Create the credential first:

1. Open https://tryharvest.ai/agents and sign in with Google.
2. Create an agent and save its one-time credential.
3. Expose it only to the installer process as `HARVEST_TOKEN`.

Install the exact published version for your runtime:

```sh
npx --yes harvest-hosted@0.2.4 --runtime codex
npx --yes harvest-hosted@0.2.4 --runtime claude-code
```

Run only the command for your runtime. The installer writes the skill and MCP
bridge. It does not create an account, access a mailbox, or issue a credential.

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
npx -y harvest-hosted@0.2.4 claude
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
server. They keep `next_utterance` as a fallback when channel notifications do
not wake model turns.

Claude Code is currently the only supported runtime with a documented
in-process Harvest push path. Codex receives the same MCP tools through the
automatically registered bridge but uses bounded `next_utterance`, because its
normal MCP client does not expose a server-originated model-turn wake-up.

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
