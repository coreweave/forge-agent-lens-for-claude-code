# forge-agent-lens-for-claude-code

[![npm version](https://img.shields.io/npm/v/@coreweave/forge-agent-lens-for-claude-code.svg)](https://www.npmjs.com/package/@coreweave/forge-agent-lens-for-claude-code)
[![CI](https://github.com/coreweave/forge-agent-lens-for-claude-code/actions/workflows/ci.yml/badge.svg)](https://github.com/coreweave/forge-agent-lens-for-claude-code/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/@coreweave/forge-agent-lens-for-claude-code.svg)](https://github.com/coreweave/forge-agent-lens-for-claude-code/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@coreweave/forge-agent-lens-for-claude-code.svg)](https://github.com/coreweave/forge-agent-lens-for-claude-code/blob/main/package.json)

Trace Claude Code sessions with CoreWeave Forge AgentLens for observability and debugging. Every session, turn, tool call, and subagent is logged as a structured trace, with no code changes required.

> [!WARNING]
> Prompts, responses, and tool inputs and outputs are sent unredacted to W&B.
> See [Data Disclosure](#data-disclosure) before installing.

## Requirements

- Node.js 18.19+ or 20.6+
- Claude Code
- A [W&B account](https://forge.coreweave.com/wandb) and project

If you installed `@coreweave/forge-claude-code`, remove it first so sessions are not traced twice:

```bash
forge-claude-code uninstall
npm uninstall -g @coreweave/forge-claude-code
```

## Quick Start

**1. Install the CLI**

```bash
npm install -g @coreweave/forge-agent-lens-for-claude-code
```

**2. Run the installer**

```bash
forge-agent-lens-for-claude-code install
```

This will:
- Create `~/.forge-agent-lens-for-claude-code/settings.json`
- Register the plugin in Claude Code
- Prompt for your Forge project (`entity/project`) and W&B API key if not already set

Your W&B API key is available at https://forge.coreweave.com/wandb/authorize.

For CI, bootstrap scripts, or other automated systems, you can skip prompts:

```bash
FORGE_TRACE_PROJECT=my-entity/my-project \
WANDB_API_KEY=<your-api-key> \
forge-agent-lens-for-claude-code install --non-interactive
```

In non-interactive mode, the installer still creates config, registers the Claude marketplace, and installs the plugin. It does not prompt for missing values. Instead, it:
- Uses `FORGE_TRACE_PROJECT` and `WANDB_API_KEY` from the environment when present
- Warns and continues if either value is missing
- Leaves environment-provided values in the environment rather than writing them into `settings.json`

By default, `claude plugin marketplace add` clones `coreweave/forge-agent-lens-for-claude-code` from GitHub. In CI or container sandboxes without git/SSH access to GitHub, pass `--source=local` to register the marketplace from the npm-installed tree on disk instead:

```bash
npm install -g @coreweave/forge-agent-lens-for-claude-code
forge-agent-lens-for-claude-code install --non-interactive --source=local
```

`--source=local` requires the package to be installed globally via npm first (it reads from `$(npm root -g)/@coreweave/forge-agent-lens-for-claude-code`). Upgrades follow the npm cadence; the marketplace ref drift check is skipped for local sources.

**3. Restart or launch Claude Code**

If Claude Code is already running, reload plugins from inside the session:

```
/reload-plugins
```

Otherwise, launch Claude Code from any folder:

```bash
claude
```

Sessions are traced automatically from this point, across **all** Claude Code sessions on this machine. Tracing is not scoped to a single Claude Code project. To stop tracing, run `forge-agent-lens-for-claude-code uninstall`.

Open your Forge project in CoreWeave Forge AgentLens to see them.

---

## Data Disclosure

This plugin sends Claude Code session data to CoreWeave Forge AgentLens.

That data can include sensitive content, including:
- user prompts
- Claude responses
- tool inputs
- tool outputs
- file paths and file contents read by Claude Code tools
- shell commands and shell output
- fetched URLs and fetched page content

If Claude Code accesses secrets, credentials, proprietary source code, personal
data, or other confidential material during a session, that information may be
logged to CoreWeave Forge AgentLens as part of the trace.

PII scrubbing and sensitive-data redaction are **not yet implemented** in the
current version. If you cannot send this data to CoreWeave Forge AgentLens under your security
or compliance requirements, do not install or enable this plugin yet.

---

## Configuration

```bash
# Show all current settings (env-var overrides are flagged in the output)
forge-agent-lens-for-claude-code config show

# Read a single setting (resolves env-var overrides)
forge-agent-lens-for-claude-code config get project

# Set your Forge project
forge-agent-lens-for-claude-code config set project my-entity/my-project

# Set your W&B API key
forge-agent-lens-for-claude-code config set wandb_api_key <your-api-key>

# (Optional) Customize the agent name shown in CoreWeave Forge AgentLens (default: claude-code)
forge-agent-lens-for-claude-code config set agent_name my-team-bot
```

You can also set these via environment variables — they take precedence over the settings file:

```bash
export FORGE_TRACE_PROJECT=my-entity/my-project
export WANDB_API_KEY=<your-api-key>
export FORGE_CLAUDE_CODE_AGENT_NAME=my-team-bot
```

This is especially useful with `forge-agent-lens-for-claude-code install --non-interactive`, where the installer checks these variables instead of prompting.

---

## Check Status

```bash
forge-agent-lens-for-claude-code status
```

Each line shows `✓` (OK), `✗` (action needed), or `-` (not yet active but not an error).

If sessions are not appearing in CoreWeave Forge AgentLens, check the daemon log for errors:

```bash
forge-agent-lens-for-claude-code logs              # last 50 lines (default)
forge-agent-lens-for-claude-code logs --tail 200   # last N lines
forge-agent-lens-for-claude-code logs --follow     # tail -f
```

The log file is also directly at `~/.forge-agent-lens-for-claude-code/logs/daemon.log`.

For more verbose daemon output while diagnosing an issue, enable debug mode:

```bash
forge-agent-lens-for-claude-code config set debug true
# or, just for the current shell session:
export FORGE_CLAUDE_CODE_DEBUG=1
```

---

## Skills

Once the plugin is installed, three skills are available directly inside any Claude Code session. They use a `/forge:forge-*` naming pattern (rather than the shorter `/forge:install` form) to avoid colliding with Claude Code's built-in skills.

### `/forge:forge-install`

Walks through the full installation and configuration flow interactively. Use this on a fresh machine or to diagnose a broken setup. Claude will check for the CLI, run the installer, prompt for missing config values, and verify everything is working.

```
/forge:forge-install
```

### `/forge:forge-status`

Checks the current plugin status and explains any issues. Equivalent to running `forge-agent-lens-for-claude-code status` but Claude interprets the output and tells you exactly what to fix.

```
/forge:forge-status
```

### `/forge:forge-config`

Read or update plugin configuration without leaving Claude Code.

```
# Show current config
/forge:forge-config

# Set a value directly
/forge:forge-config set project my-entity/my-project
/forge:forge-config set wandb_api_key <your-api-key>
```

---

## What Gets Traced

The plugin emits OTel spans that follow the [GenAI semantic
conventions](https://github.com/open-telemetry/semantic-conventions-genai) and ships
them to the CoreWeave Forge AgentLens observability backend (`/agents/otel/v1/traces`).
Each user prompt produces one OTel trace (the "turn"); multi-turn
conversations are stitched together server-side via
`gen_ai.conversation.id`, which is set to the Claude Code session id on
every span in the turn.

Spans are built with the [CoreWeave Forge SDK](https://www.npmjs.com/package/@coreweave/forge-sdk).
Every span carries the `forge.integration.*` identity of this plugin; the
OTLP resource reports `service.name = forge-agent-lens-for-claude-code` and
`wandb.sdk.name = forge`.

```
invoke_agent claude-code                  (root — one trace per user prompt)
├─ chat <model>                           (each LLM API call within the turn)
├─ execute_tool <tool_name>               (each tool call: Read, Bash, Grep, ...)
└─ invoke_agent <subagent_type>           (subagent dispatched via the `Agent` tool)
   ├─ chat <model>                        (subagent LLM calls)
   └─ execute_tool <tool_name>            (tools the subagent ran)
```

Subagents (dispatched via Claude Code's `Agent` tool) are emitted as their
own nested `invoke_agent` span — a direct child of the turn span, sibling
of any regular tool calls — not as an `execute_tool Agent` span. This
matches the CoreWeave Forge AgentLens chat view's reference structure, where nested
`invoke_agent` spans render as an `agent_start` lifecycle marker for the
subagent. The spawning tool_use_id is preserved on the inner
`invoke_agent` span as `forge.claude_code.subagent.spawning_tool_call_id`.

Permission requests appear as `forge.permission_request` events on the
corresponding tool or agent call span; context-window compaction is recorded as
`weave.compaction.{summary,items_before,items_after}` attributes on the
turn span open at compaction time (or the next turn if compaction fires
between turns).

Roots export at Stop once the snapshot is complete and all children have ended.
Compaction after root export attaches to the next turn. Later output appears
only as child spans; exported root attributes stay frozen.

Each span includes per-call token usage (`gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, cache and reasoning token counts), model name
(`gen_ai.request.model`), tool inputs and outputs
(`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`), timing, and the
textual content of prompts and assistant messages
(`gen_ai.input.messages`, `gen_ai.output.messages`).

Important: tool inputs and outputs may contain sensitive information. In
practice this can include file contents, command output, URLs, fetched content,
and other data handled by Claude Code during a session. That information is sent
to CoreWeave Forge AgentLens. PII scrubbing/redaction is planned for a future release, but is
not available today.

---

## Uninstall

```bash
forge-agent-lens-for-claude-code uninstall
```

Pass `--keep-logs` to preserve the log directory.

---

## Dedicated and On-Prem Instances

Only needed for W&B Dedicated Cloud or a self-hosted instance. On SaaS, traces go to `https://trace.wandb.ai` with no setup.

Set `WANDB_BASE_URL` to your deployment before launching Claude Code:

```bash
export WANDB_BASE_URL=https://your-instance.wandb.io
```

Traces then go to its trace server at `https://your-instance.wandb.io/traces`. Setting `WANDB_BASE_URL` to the SaaS API host, `https://api.wandb.ai`, still sends traces to `https://trace.wandb.ai`.

To use a different trace server, set `FORGE_TRACE_BASE_URL` to its URL. It takes precedence over `WF_TRACE_SERVER_URL`, which takes precedence over `WANDB_BASE_URL`.

The daemon reads these variables once, at startup. If it is already running, set them and restart it from the same shell:

```bash
export WANDB_BASE_URL=https://your-instance.wandb.io
forge-agent-lens-for-claude-code restart
```

---

## Contributing

See [CONTRIBUTING.md](https://github.com/coreweave/forge-agent-lens-for-claude-code/blob/main/CONTRIBUTING.md). Contributions require agreeing to the
[CoreWeave CLA](https://github.com/coreweave/forge-agent-lens-for-claude-code/blob/main/CLA.md).

## License

[Apache License 2.0](https://github.com/coreweave/forge-agent-lens-for-claude-code/blob/main/LICENSE)
