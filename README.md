# Codex OpenViking Memory

[简体中文](README.zh-CN.md) · [Setup](docs/setup.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md)

A Windows-first bridge that lets Codex propose small memory summaries, ask the human to choose, and submit only the selected summaries to OpenViking. Version **0.1.0** is an initial release with automated tests; a fresh real-user deployment has not yet been verified end to end.

The model judges whether a current human statement has lasting value. Local hooks enforce confirmation and submission boundaries. The read-only MCP server provides eight scoped tools without exposing a write tool. Chat transcripts are not the capture payload.

## Requirements

- Node.js 22 or later; no npm runtime dependencies.
- Windows and PowerShell 7 (`pwsh`) for installation and DPAPI-protected credentials.
- An existing OpenViking server and an ordinary `user` credential for the configured account and user. The installer does not deploy OpenViking.
- A Codex client that can load a local plugin, execute `UserPromptSubmit` and `Stop` hooks, run a local stdio MCP server, and let the model invoke a local command.
- A native question/input tool if you want selectable confirmation cards. This tool is supplied by the client, not by this project, and may be absent or restricted in some clients or modes. Exact typed confirmation remains available.

## Install and activate

```powershell
git clone https://github.com/daizhonggeng/codex-openviking-memory.git
cd codex-openviking-memory
pwsh -File ./scripts/install.ps1 `
  -ServerUrl https://memory.example.com `
  -Account example-account `
  -User example-user
```

Enter the ordinary user's API key in the hidden local prompt. Do not put it in a command line, chat, repository, or issue. By default, the installer keeps runtime data under `%LOCALAPPDATA%/CodexOpenVikingMemory`, outside the checkout. `-WriteUrl` can select a separate write origin; it defaults to `-ServerUrl`.

The installer generates a local marketplace/plugin, an MCP configuration snippet, and a supportive model-rule fragment. **Installation does not automatically activate them in Codex.** Follow the printed locations to add the generated local marketplace and enable its plugin, then import the generated MCP configuration into your client. Reload the client/session as needed and verify that both hook events and the read-only MCP server are available. The installer does not silently modify your existing Codex configuration or `AGENTS.md`.

See [setup and activation](docs/setup.md) for the complete checklist, configuration, credential handling, and offline installer options. Hook responses inject the memory-review rules dynamically; the generated `AGENTS.fragment.md` is optional supporting guidance, not an assumed global installation.

## How a memory is saved

1. A human sends a normal message. The model considers its meaning in context and may decide that nothing should be saved.
2. For a useful fact, preference, current goal, or reusable lesson, the model writes a minimal candidate JSON file and invokes `propose`.
3. The candidate is encrypted locally. The model shows its actual returned ID and summary and asks for a choice using the client's native question tool when available.
4. The human explicitly selects a supported save response or types exactly `save candidate ID` or `保存候选 ID`, replacing `ID` with the actual ID.
5. `UserPromptSubmit` recognizes the human confirmation; `Stop` submits the approved batch using the pinned upstream capture scripts through a restricted transport.
6. Check `status`, then verify extraction/readback through read-only MCP before saying that the memory is fully available.

An ordinary request, a quoted instruction, a tool result, or a model-generated "save" message is not human authorization. The hook recognizes a strict confirmation format; it does not make the semantic decision to save. A question card can help collect a choice only when the client's reply reaches the hook in a supported form. If that integration is unavailable, ask the human to send the exact text command; do not simulate a click or silently approve.

## Commands

Examples use `$config` for the installer-created `config.json` path and `$cli` for the installed `runtime/bin/cli.mjs`. Set them to the paths printed by the installer. All commands below also work from the source checkout with `node ./bin/cli.mjs`.

```powershell
node $cli --help
node $cli doctor --config $config
node $cli propose --config $config --input ./candidate.json
node $cli status --config $config --id ACTUAL_CANDIDATE_ID
node $cli mcp --config $config
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

Tests use temporary directories and mocked network/transport. Windows installer smoke tests exercise a clean offline installation and preservation behavior without real credentials. They do not prove server compatibility, a particular client's hook/card integration, or successful extraction in a live account. See [testing](docs/testing.md) and the [release checklist](docs/releasing.md).

## License and source

This project is licensed under [AGPL-3.0-only](LICENSE). It includes an unchanged, deliberately limited subset of the [OpenViking](https://github.com/volcengine/OpenViking) Codex memory example at `v0.5.1.1`. See [NOTICE](NOTICE) and [vendor provenance](vendor/README.md) for the pinned tree, file hashes, and source scope. Retain the license and corresponding source when redistributing; modified network deployments must also respect the AGPL source-offer requirements.
