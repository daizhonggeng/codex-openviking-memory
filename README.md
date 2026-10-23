# Codex OpenViking Memory

[简体中文](README.zh-CN.md) · [Setup](docs/setup.md) · [Directory template](docs/template.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

A macOS and Windows bridge that lets Codex propose small memory summaries, ask the human to choose, and submit only the selected summaries to OpenViking. Version **0.2.0** adds native macOS Keychain credentials and a clean personal-context directory template alongside Windows DPAPI support.

The model judges whether a current human statement has lasting value. Local hooks enforce confirmation and submission boundaries. The read-only MCP server provides eight scoped tools without exposing a write tool. Chat transcripts are not the capture payload.

## Requirements

- Node.js 22 or later; no npm runtime dependencies.
- macOS with its native Keychain, or Windows with PowerShell 7 (`pwsh`) and DPAPI. The unified installer selects the operating-system path; Linux provisioning is not supported.
- An existing OpenViking server and an ordinary `user` credential for the configured account and user. The installer does not deploy OpenViking.
- A Codex client that can load a local plugin, execute `UserPromptSubmit` and `Stop` hooks, run a local stdio MCP server, and let the model invoke a local command.
- A native question/input tool if you want selectable confirmation cards. This tool is supplied by the client, not by this project, and may be absent or restricted in some clients or modes. Exact typed confirmation remains available.

## Install and activate

```text
git clone https://github.com/daizhonggeng/codex-openviking-memory.git
cd codex-openviking-memory
node scripts/install.mjs --server-url https://memory.example.com --account example-account --user example-user
```

Enter the ordinary user's API key in the hidden local prompt. Do not put it in a command line, chat, repository, or issue. The API key and local vault key use macOS Keychain or Windows DPAPI. Data stays outside the checkout: `~/Library/Application Support/CodexOpenVikingMemory` on macOS and `%LOCALAPPDATA%/CodexOpenVikingMemory` on Windows. `--write-url` can select a separate write origin; it defaults to `--server-url`.

The installer generates a local marketplace/plugin, an MCP configuration snippet, and a supportive model-rule fragment. **Installation does not automatically activate them in Codex.** Follow the printed locations to add the generated local marketplace and enable its plugin, then import the generated MCP configuration into your client. Reload the client/session as needed and verify that both hook events and the read-only MCP server are available. The installer does not silently modify your existing Codex configuration or `AGENTS.md`.

See [setup and activation](docs/setup.md) for the complete checklist, configuration, credential handling, and offline installer options. Hook responses inject the memory-review rules dynamically; the generated `AGENTS.fragment.md` is optional supporting guidance, not an assumed global installation.

## Personal-context directory template

Both installers initialize `knowledge/` under the data directory from `templates/personal-context/`, preserving files that already exist. This connects the earlier personal-context organization—`PROFILE.md`, `PREFERENCES.md`, `CURRENT.md`, numbered topic folders, record guides, and six blank record templates—to the bridge as a generic navigation structure. The template contains no user facts.

The local directory and remote knowledge remain separate. `template map` describes how local relative paths correspond to `viking://user/<user>/resources/personal-context/`; native confirmed memories stay under `viking://user/<user>/memories/`. Initializing or mapping creates no remote resource, uploads no files, writes no memory, and does not add Git-based knowledge persistence. See the [template guide](docs/template.md).

## How a memory is saved

1. A human sends a normal message. The model considers its meaning in context and may decide that nothing should be saved.
2. For a useful fact, preference, current goal, or reusable lesson, the model writes a minimal candidate JSON file and invokes `propose`.
3. The candidate is encrypted locally. The model shows its actual returned ID and summary and asks for a choice using the client's native question tool when available.
4. The human explicitly selects a supported save response or types exactly `save candidate ID` or `保存候选 ID`, replacing `ID` with the actual ID.
5. `UserPromptSubmit` recognizes the human confirmation; `Stop` submits the approved batch using the pinned upstream capture scripts through a restricted transport.
6. Check `status`, then verify extraction/readback through read-only MCP before saying that the memory is fully available.

An ordinary request, a quoted instruction, a tool result, or a model-generated "save" message is not human authorization. The hook recognizes a strict confirmation format; it does not make the semantic decision to save. A question card can help collect a choice only when the client's reply reaches the hook in a supported form. If that integration is unavailable, ask the human to send the exact text command; do not simulate a click or silently approve.

## Commands

Run these commands from the source checkout on either platform. Replace `CONFIG_PATH` with the installer-created `config.json` path. To use the installed copy, replace `./bin/cli.mjs` with the quoted absolute `runtime/bin/cli.mjs` path printed by the installer.

```text
node ./bin/cli.mjs --help
node ./bin/cli.mjs doctor --config "CONFIG_PATH"
node ./bin/cli.mjs propose --config "CONFIG_PATH" --input "CANDIDATE_JSON_PATH"
node ./bin/cli.mjs status --config "CONFIG_PATH" --id ACTUAL_CANDIDATE_ID
node ./bin/cli.mjs mcp --config "CONFIG_PATH"
node ./bin/cli.mjs template init --config "CONFIG_PATH"
node ./bin/cli.mjs template map --config "CONFIG_PATH"
```

Candidate input has exactly these fields:

```json
{
  "summary": "The user prefers brief answers with explicit verification results.",
  "kind": "preference",
  "source": "current-human-statement"
}
```

Allowed kinds are `profile`, `preference`, `current`, and `knowledge`. The example is sample data, not an asserted fact about the person installing the project. Keep candidate input files outside the checkout; they contain sensitive plaintext until you remove them. See [command reference](docs/commands.md).

## Read-only MCP

The bridge exposes `health`, `find`, `search`, `read`, `list`, `tree`, `grep`, and `glob`. Access is limited to the configured user's native memories and `resources/personal-context/` subtree. Searches use `mode="list"` without `session_id`. No `remember`, capture, raw-session upload, or general write tool is exposed. Server authorization remains necessary in addition to these local checks.

## Development and verification

```powershell
node --test
npm run verify:vendor
```

Tests use temporary directories and mocked network/transport. Platform-specific tests cover Windows DPAPI installation and macOS Keychain installation with synthetic secrets; macOS checks require a native macOS runner. The CI configuration targets Linux, Windows, and macOS on Node.js 22/24. Its presence is not a claim that a particular run passed. Tests do not prove server compatibility, a client's hook/card integration, or live extraction. See [testing](docs/testing.md) and the [release checklist](docs/releasing.md).

## License and source

This project is licensed under [AGPL-3.0-only](LICENSE). It includes an unchanged, deliberately limited subset of the [OpenViking](https://github.com/volcengine/OpenViking) Codex memory example at `v0.5.1.1`. See [NOTICE](NOTICE) and [vendor provenance](vendor/README.md) for the pinned tree, file hashes, and source scope. Retain the license and corresponding source when redistributing; modified network deployments must also respect the AGPL source-offer requirements.
