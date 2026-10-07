# Agent host installation references

HAR-233 source lane, checked 2026-10-05. All client entries reuse the existing
bundled stdio bridge, which reads the existing private Harvest config. No new
body, provider, or wake mechanism is introduced. Native manifests are distributed
from this Git checkout; the npm file allowlist remains unchanged. A future npm
plugin distribution must explicitly include `.claude-plugin/plugin.json`,
`.claude-plugin/marketplace.json`, `.cursor-plugin/plugin.json`, and
`gemini-extension.json` and update the packed allowlist check. No package version,
lockfile, or generated bundle change is part of this lane.

## Primary sources

- [Claude marketplace](https://code.claude.com/docs/en/plugin-marketplaces) and
  [manifest](https://code.claude.com/docs/en/plugins-reference): native catalog,
  root-relative components and inline MCP entries. Channel loading stays on the
  existing user-scoped launcher; plugin registration is not Channels acceptance.
- [Cursor plugin schema](https://cursor.com/docs/reference/plugins) and
  [local installation](https://cursor.com/docs/plugins): `mcpServers` inline
  overrides generic `mcp.json`; `${CURSOR_PLUGIN_ROOT}` resolves the bridge.
  Public marketplace requires open-source plugins; local import depends on admin policy.
- [Gemini extension schema](https://geminicli.com/docs/extensions/reference/)
  and [skills](https://geminicli.com/docs/cli/skills/): `${extensionPath}`,
  `mcpServers`, existing `skills/` discovery, user `~/.gemini/skills`.
- [Windsurf/Cascade MCP](https://docs.windsurf.com/windsurf/cascade/mcp) and
  [skills](https://docs.windsurf.com/windsurf/cascade/skills): current docs redirect
  to Devin; current config is `$XDG_CONFIG_HOME/devin/mcp_config.json` and skills
  are in the same user directory. Legacy Windsurf paths are not silently migrated.
- [Copilot CLI MCP](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers)
  and [skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills):
  local `type`, `tools`, user config and user skills; not cloud-agent config.
- [Junie MCP](https://junie.jetbrains.com/docs/junie-cli-mcp-configuration.html)
  and [skills](https://junie.jetbrains.com/docs/agent-skills.html): CLI/IDE shared
  user paths; stdio avoids conflicting CLI/IDE bearer-header documentation.
- [OpenClaw registry](https://docs.openclaw.ai/cli/mcp/registry) and
  [skills](https://docs.openclaw.ai/tools/skills): native `mcp add` preserves JSON5;
  a skills install alone is not MCP registration. Eligible runtime must actually
  expose the tools. ACP injection and automatic turn wake are not promised.

## AgentCall provenance

The single-plugin marketplace layout and per-host installation outline were
reviewed against [pattern-ai-labs/agentcall](https://github.com/pattern-ai-labs/agentcall/tree/9b96f6739c3ea3384fbb8c904c63b885d6e455ff),
exact commit `9b96f6739c3ea3384fbb8c904c63b885d6e455ff`.
Reviewed donor files: `.claude-plugin/marketplace.json`, `.grok-plugin/plugin.json`,
`gemini-extension.json`, `README.md`, `LICENSE`. AgentCall's Gemini manifest
contains metadata only; Harvest adds MCP fields from official Gemini docs.
No AgentCall calling code, voice policy, subprocess model, or unsupported install
command was imported. The donor is MIT; Harvest's own license remains proprietary.
The donor license notice is retained below for the adapted distribution outline.

MIT License

Copyright (c) 2026 AgentCall, Pattern AI Labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
