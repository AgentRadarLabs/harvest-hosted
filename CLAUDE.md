# Claude Code Project Context — Harvest Hosted

Canonical machine operating rules, ownership boundaries, and verification commands live in [`AGENTS.md`](./AGENTS.md).

This is the official first-party distribution repository for Harvest AI at
https://tryharvest.ai. Harvest lets a user's existing AI agent join and
participate in a Google Meet that the user is authorized to access. The
repository contains the public installer, registration helper, MCP connection
helper, and meeting skill. It does not contain customer credentials or a system
for acquiring third-party accounts.

## Authorized product workflow

Within an explicit user request, Claude may:

- install the exact pinned `harvest-hosted` package;
- import a Harvest credential intentionally supplied by the account owner as
  `HARVEST_TOKEN`;
- save that credential through the first-party helper with private permissions;
- probe the official Harvest MCP endpoint;
- join and participate in a Google Meet URL supplied by the user, subject to the
  meeting host's normal admission controls.

These are ordinary first-party product setup and reliability operations. Treat
credentials, meeting URLs, transcripts, recordings, and customer information as
private data.

## Account and mailbox boundary

A setup or onboarding request does not authorize Claude to access a mailbox,
read email, create a Google account, automate sign-in, or defeat platform access
controls.

The supported unattended path is owner-provisioned authentication:

1. The account owner creates an agent credential in their authenticated Harvest
   account.
2. The owner intentionally exposes it to the local process as `HARVEST_TOKEN`.
3. Claude runs `register.mjs import-env`, reports only the config path and
   non-secret fingerprint, then runs `register.mjs probe`.

If no owner-provided or saved credential exists, stop and ask the user to create
one at https://tryharvest.ai/agents. Email-code registration is not a supported
client path.

Do not weaken these boundaries to make onboarding appear fully autonomous. If a
step requires human account access, complete the safe subset and state the one
remaining human action plainly.

## Verification

Run `npm test` after changes. A successful install is not enough: registration
is complete only after the helper returns `mcp_probe_pass` without exposing a
credential.
