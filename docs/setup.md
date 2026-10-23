# Setup and activation

## Start with an ordinary identity

Use an existing OpenViking instance and a credential whose authenticated identity is exactly the configured account and user with role `user`. Root/admin credentials are not supported. The `doctor` command checks authenticated identity and read scope and writes local readiness only after successful checks. Do not bypass a failed check to force capture.

Node.js 22+ must be available. On Windows, also install PowerShell 7 (`pwsh`); on macOS the installer uses the native Keychain. Run the unified installer from a clone of this repository using the same command on either platform:

```text
node scripts/install.mjs --server-url https://memory.example.com --account example-account --user example-user
```

Required options are `--server-url`, `--account`, and `--user`. Optional options are `--write-url`, `--data-dir`, `--skip-doctor`, `--no-credential-prompt`, and macOS-only `--keychain PATH`. The latter selects an isolated native keychain for synthetic tests; normal installation uses the user's default Keychain. On Windows the entry point delegates to `scripts/install.ps1` with equivalent arguments and the inherited terminal. Linux provisioning is not supported.

Origins must have no path, query, fragment, or embedded credentials. Use HTTPS; HTTP is accepted only for loopback development. Account and user names contain 1–64 letters, digits, periods, underscores, or hyphens, beginning with a letter or digit.

| Platform | Default data directory | Native credential storage |
| --- | --- | --- |
| macOS | `~/Library/Application Support/CodexOpenVikingMemory` | Keychain API-key and vault-key items, with service identity derived from the absolute data directory |
| Windows | `%LOCALAPPDATA%/CodexOpenVikingMemory` | CurrentUser DPAPI files in the ACL-protected `secrets/` directory |

Choose a private absolute directory outside the repository when overriding `--data-dir`. The installer discovers the needed executable paths, copies allowlisted runtime and template source, and prompts locally without echoing the API key. The macOS data directory is private (`0700`); Windows private subdirectories receive restricted ACLs. Compatible existing configuration, keys, and knowledge files are preserved; incompatible configuration reuse is rejected rather than silently overwritten.

For an offline packaging smoke test, use a new temporary directory with `--skip-doctor --no-credential-prompt`. The prompt-skip option requires the doctor-skip option. This does not provision a missing API credential or establish readiness. Run a normal credential-provisioning install and `doctor` before actual use.

## Files outside the checkout

```text
CodexOpenVikingMemory/
  config.json
  runtime/                         # copied application source and pinned vendor source
  secrets/api-key.dpapi             # Windows only: DPAPI-protected API key
  secrets/vault-key.dpapi           # Windows only: DPAPI-protected vault key
  knowledge/                       # generic Markdown directory template; not auto-uploaded
  candidate-vault/                  # encrypted candidates and local decisions
  approved-hook-data/               # restricted capture working data
  state/readiness.json
  marketplace/plugins/codex-openviking-memory/
  mcp-config.toml
  AGENTS.fragment.md
```

Use the actual generated layout and paths printed by the installer. On macOS, writes use the current user's default Keychain (normally the login Keychain), and reads use the user's Keychain search list unless a test keychain is specified. Item accounts are fixed as `api-key` and `vault-key`; secrets are not plaintext files in this directory. The Keychain service identity is derived from a hash of the absolute data directory, so moving the data directory changes credential lookup. Native writes send the secret through stdin rather than process arguments. A locked Keychain or access denial fails without falling back to plaintext storage or another identity. On Windows, DPAPI ties secrets to the Windows user. Copying application data to another machine, account, or path does not automatically provision usable credentials. Approved capture working data and any user-edited Markdown can contain sensitive summaries; protect the whole private data directory.

Both installers invoke the installed CLI's `template init` after copying the runtime. Existing files are skipped rather than overwritten; there is no upload, import, background watcher, or Git synchronization. See [the template guide](template.md) for the layout, resource mapping, and the distinction between blank templates and facts.

The configuration schema is:

```json
{
  "schemaVersion": 1,
  "serverUrl": "https://memory.example.com",
  "writeUrl": "https://memory.example.com",
  "account": "example-account",
  "user": "example-user",
  "dataDir": "C:/private-memory-data"
}
```

The raw schema stays at version 1 with these same six fields, so existing v0.1 configuration files do not need rewriting. `dataDir` must be an absolute path appropriate for the platform; replace the example Windows path when using macOS. `writeUrl` defaults to `serverUrl`. `knowledgeDir` is derived as `dataDir/knowledge`, not added to the JSON. Read roots are derived from the user, not independently configurable:

- `viking://user/example-user/memories/`
- `viking://user/example-user/resources/personal-context/`

Environment overrides `OVCM_API_KEY` and `OVCM_VAULT_KEY` exist for isolated tests/CI; they are not a replacement for normal native provisioning. The vault key is a base64-encoded 32-byte key. macOS runtime tests can set `OVCM_KEYCHAIN_PATH` to the same isolated keychain supplied to the test installer via `--keychain`; this override is not a new public configuration field. Never persist secret environment values in project configuration, scripts, logs, or issue reports.

## Activate in your client

1. Locate the generated `.agents/plugins/marketplace.json` and plugin directory printed by the installer. Add this local marketplace using your client's plugin management interface and enable `codex-openviking-memory`.
2. Import the generated `mcp-config.toml` snippet into the appropriate Codex MCP configuration. It starts the installed Node CLI with `mcp --config` and an absolute configuration path. Keep an existing configuration and merge the new server entry carefully.
3. Reload as required by your client. Confirm the plugin supplies both `UserPromptSubmit` and `Stop`, and that the MCP server exposes only the eight documented tools.
4. Run the installed CLI's `doctor --config <path>` and resolve any identity/readiness failure.
5. Inspect `template map --config <path>` to see the initialized local knowledge directory and remote path conventions. A mapping does not establish that the remote files exist.
6. Send a harmless message and inspect client hook status. If a save choice is offered, use only sample information until you have verified the entire local workflow.

The installer generates configuration but does not edit the user's existing Codex config or global instructions. The CLI injects review instructions through the hook response; `AGENTS.fragment.md` is supportive documentation you may add deliberately. Plugin discovery, hook support, MCP setup, and native question tools vary by client and version. The project cannot create a native question tool or guarantee its availability outside a supported client mode.

Official references: [Codex plugins](https://developers.openai.com/codex/plugins/) and [Codex MCP](https://developers.openai.com/codex/mcp/). Consult your installed client's documentation for its exact activation UI; these links are references, not evidence of universal feature availability.

## Confirm and verify

The model should show a candidate's actual ID, summary, and kind. When a native choice tool is unavailable or its output is unsupported, use the explicit single-message fallback `save candidate ID` or `保存候选 ID`. A reply such as “yes”, a pasted tool result, or a quoted command should not be treated as permission.

After the next `Stop` event, run `status --config <path> --id <actual-id>`. A submitted batch may still be queued or extracting. Use read-only MCP to verify the expected memory content after server processing. Do not infer successful indexing from a local approval, a submitted task ID, or a clean `doctor` result.
