# Harvest Hosted

Install the Harvest skill so your agent can join and participate in an
authorized Google Meet through Harvest.

## Primary setup

Give your coding agent this prompt:

> Clone `https://github.com/f1scord/harvest-hosted.git`, read its root
> `SKILL.md` completely, run the installer for your runtime, and follow the
> skill. Complete email-code self-registration yourself. If an authorized
> email MCP or mailbox tool is connected, determine its mailbox address, send
> the code there, retrieve it, verify it, and save the credential without
> asking me anything. Ask me for an email or code only when mailbox access is
> unavailable or ambiguous. Do not open an API-key dashboard, and do not print
> or commit credentials.

Or install it yourself:

```sh
git clone https://github.com/f1scord/harvest-hosted.git
cd harvest-hosted
node scripts/install.mjs --runtime codex
```

For Claude Code, replace `codex` with `claude-code`.

## Secondary setup with npm

```sh
npx harvest-hosted@0.1.0 --runtime codex
```

The Git clone + root `SKILL.md` path above is the primary onboarding path. npm
is a secondary installer with the same fail-closed behavior.

The clone installer copies `SKILL.md` and its fail-closed registration helpers.
For Claude Code it also registers the hosted Harvest MCP server at user scope
with dynamic authorization, so the credential is never stored in Claude's MCP
configuration or CLI arguments. Restart Claude Code once after installation so
the new tools load. The installer never prints API keys. If an installed file
differs, installation stops; remove or back up an old installation yourself
before replacing it.

## Requirements

- Node.js 18 or newer
- A Harvest API token in `HARVEST_TOKEN`, a previously saved credential, or an
  explicitly approved fake/staging registration URL
- Claude Code on `PATH` when installing for `claude-code`; the installer
  configures the Harvest MCP endpoint automatically

## Self-serve registration

The helper uses `https://gateway.84.32.83.100.sslip.io` for public email-code
registration, saves the returned credential with private file permissions,
and can probe MCP without printing the code or credential:

```sh
node ~/.codex/skills/harvest/register.mjs send --email you@example.com
node ~/.codex/skills/harvest/register.mjs verify --email you@example.com --code CODE_FROM_EMAIL
node ~/.codex/skills/harvest/register.mjs probe
```

An agent with authorized mailbox access should determine the connected mailbox
address from provider or account metadata, send the code to that address,
retrieve the newest matching Harvest access-code email, and proceed without
asking the user anything. It must not scan unrelated mail to guess the address.
Only when mailbox access is unavailable or ambiguous should it ask for an email
or the six-digit code. The API key is minted after verification and saved
locally; it is never sent in the email or printed.

For Claude Code, the helper is under `~/.claude/skills/harvest/`. Set
`HARVEST_REGISTRATION_API_URL` only for an explicitly approved fake or staging
gateway. The helper never falls back to a demo, shared, internal, or another
user's token. The published `harvest-hosted@0.1.0` remains the secondary
installer; clone + `SKILL.md` is the primary path.

## Verify this checkout

```sh
node scripts/verify-public-tree.mjs
```

The verifier checks the public allowlist, required documentation, likely secret
material, npm package contents, and the installer in an isolated temporary home.

## License

This is proprietary software, not open source. One local clone and unmodified
installation for authorized Harvest use are permitted. Copying, modification,
forking, redistribution, mirroring, derivative works, and commercial reuse are
otherwise prohibited. See [LICENSE](LICENSE).
