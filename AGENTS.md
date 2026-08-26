# Harvest Hosted Client — Agent Guidance (`harvest-hosted`)

Canonical operating rules and architecture guidance for AI coding assistants working in `harvest-hosted` (client distribution package).

---

## 1. Repository Purpose
`harvest-hosted` is the official client distribution package and [Agent Plugins 1.0.0](https://agent-plugins.org) specification implementation for [Harvest](https://tryharvest.ai). It connects Claude Code and Codex agents to a hosted Harvest meeting body over MCP, managing private credential import, connection health probes, Claude native channel launching, and Codex bounded polling.

## 2. Ownership & Non-Ownership Boundaries
- **OWNS**: Standalone client npm package (`harvest-hosted`), Agent Plugins 1.0.0 manifests (`plugin.json`, `mcp.json`, `skills/harvest/SKILL.md`), Claude Code launcher (`harvest-hosted claude`), credential import helper (`scripts/register.mjs`), installer (`scripts/install.mjs`), and offline test verifiers (`scripts/verify-*.mjs`).
- **EXPLICITLY DOES NOT OWN**: Backend meeting automation, Chromium instances, WebRTC audio injection, or customer dashboard web pages.

## 3. Architecture & Runtime Entry Points
- **Package Manifest**: `package.json` (bin: `harvest-hosted` -> `scripts/install.mjs`).
- **Agent Plugin 1.0.0**: `plugin.json`, `mcp.json`, and `skills/harvest/SKILL.md`.
- **Token Registration & Probe**: `scripts/register.mjs` (imports `HARVEST_TOKEN`, writes private `~/.harvest-hosted/config.json` with `0o600` permissions, probes MCP endpoint).
- **Claude Launcher**: `harvest-hosted claude` (launches Claude Code with `--dangerously-load-development-channels server:harvest-hosted`).
- **Codex Bounded Polling**: `next_utterance` MCP tool with `include_partials: true`.

## 4. Directory Map
```
├── plugin.json           # Agent Plugins 1.0.0 manifest
├── mcp.json              # Model Context Protocol server configuration
├── skills/
│   └── harvest/
│       └── SKILL.md      # Bundled Harvest agent skill instructions
├── scripts/              # Install, register, launcher, and verification scripts
├── evidence/             # Verified launcher transcripts and test artifacts
└── package.json          # Package manifest (files allowlist, bin entries)
```

## 5. Supported Local Setup
```bash
# 1. Install dependencies
npm install

# 2. Build channel bridge
npm run build:bridge
```

## 6. Exact Verification Commands
```bash
npm test            # Run all verification suites (public tree, registration, install, launcher)
```

## 7. Cross-Repository Dependencies & Links
- **[`harvest-app`](https://github.com/GigRadar/harvest-app)**: Customer dashboard where users create agents and generate `HARVEST_TOKEN`.
- **[`harvest-bot`](https://github.com/GigRadar/harvest-bot)**: Hosted meeting body and MCP gateway server.
- **[`harvest-infra`](https://github.com/GigRadar/harvest-infra)**: AWS cloud infrastructure.
- **Architecture Contract**: See `salesharvest-bot/docs/architecture/harvest-repository-map.md`.

## 8. Production & Secret Boundaries
- **Private Config**: Credentials stored in `~/.harvest-hosted/config.json` must always use `0o600` owner-only permissions.
- **Zero Command-Line Leaks**: API tokens must never appear in command-line arguments, process titles, or unredacted output.
- **NPM Release Policy**: Do not attempt to publish npm releases without Anton's 2FA authentication.

## 9. Change Rules & Common Pitfalls
- **Product Name**: Always use **Harvest**.
- **No Email OTP**: Never invent email-code self-registration flows. The single canonical credential path is Google Sign-in on `tryharvest.ai/agents`.
- **Packaging Allowlist**: Only files listed in `package.json` `files` field are published. Never commit secrets to the npm bundle.

## 10. Definition of Done
A task in `harvest-hosted` is complete only when:
1. `npm test` passes 100% (public tree, registration, Claude install, Codex install, Claude launcher).
2. Plugin manifests (`plugin.json`, `mcp.json`, `SKILL.md`) are valid.
3. No secrets or private config files are added to git.
