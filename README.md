# Harvest Hosted

Install the Harvest skill so your agent can join and participate in an
authorized Google Meet through Harvest.

## Primary setup

Give your coding agent this prompt:

> Please install the Harvest join-meeting skill from:
>
> https://github.com/f1scord/harvest-hosted
>
> Read the README and the complete SKILL.md before acting. Follow the
> installation instructions for the AI tool, agent, or framework you are
> currently running in.
>
> I own or control the connected mailbox and explicitly authorize you to use
> it only for this one-time Harvest signup and verification. Do not inspect
> unrelated email. All public registration and MCP requests must use the
> first-party https://tryharvest.ai domain.
>
> Complete Harvest registration autonomously:
>
> 1. Check whether a valid Harvest credential already exists.
> 2. If not, check for the mailbox connection I explicitly authorized above.
> 3. If exactly one mailbox is connected, determine its email address from
>    account metadata. Do not ask me for it and do not scan unrelated emails to
>    guess it.
> 4. Send the Harvest verification code to that address.
> 5. Search only for the newest matching "Your Harvest access code" email,
>    retrieve its six-digit code, and do not open unrelated messages.
> 6. Verify the code and let the registration helper save the API key in the
>    standard local Harvest config.
> 7. Tell me the config path and non-secret key fingerprint so I retain control
>    of the account. Never print, repeat, log, expose, or commit the full
>    verification code or API key.
> 8. Do not require an API-key dashboard for initial setup.
> 9. Ask me for an email or verification code only if mailbox access is
>    unavailable or ambiguous.
> 10. Run the Harvest MCP probe and continue only after receiving
>     `mcp_probe_pass`.
>
> After registration succeeds, ask me for an authorized Google Meet URL, join
> it through Harvest, report the real join status, and remain active in the
> meeting according to SKILL.md.

Or install it yourself:

```sh
git clone https://github.com/f1scord/harvest-hosted.git
cd harvest-hosted
node scripts/install.mjs --runtime codex
```

For Claude Code, replace `codex` with `claude-code`.

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

The helper uses the first-party `https://tryharvest.ai` domain for public
email-code registration and MCP, saves the returned credential with private
file permissions, and can probe MCP without printing the code or credential:

```sh
node ~/.codex/skills/harvest/register.mjs send --email you@example.com
node ~/.codex/skills/harvest/register.mjs verify --email you@example.com --code CODE_FROM_EMAIL
node ~/.codex/skills/harvest/register.mjs probe
```

The user's prompt must explicitly authorize the one-time signup and mailbox
access. An agent with exactly one authorized mailbox should determine its
address from provider or account metadata, send the code, and search only for
the newest matching `Your Harvest access code` message. It must not inspect
unrelated mail. Only when mailbox access is unavailable or ambiguous should it
ask for an email or the six-digit code. The API key is minted after
verification and saved locally; it is never sent in the email or printed. The
agent reports the saved config path and non-secret fingerprint to the account
owner.

For Claude Code, the helper is under `~/.claude/skills/harvest/`. Set
`HARVEST_REGISTRATION_API_URL` only for an explicitly approved fake or staging
gateway. The helper never falls back to a demo, shared, internal, or another
user's token. Clone + the root `SKILL.md` is the canonical installation path.

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
