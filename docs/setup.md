# Setup and activation

## Start with an ordinary identity

Use an existing OpenViking instance and a credential whose authenticated identity is exactly the configured account and user with role `user`. Root/admin credentials are not supported. The `doctor` command checks authenticated identity and read scope and writes local readiness only after successful checks. Do not bypass a failed check to force capture.

Node.js 22+ and PowerShell 7 must be available to the installer. Run the installer from a clone of this repository:

```powershell
pwsh -File ./scripts/install.ps1 `
  -ServerUrl https://memory.example.com `
  -Account example-account `
  -User example-user
```

Supported installer options are `-ServerUrl`, `-Account`, `-User`, optional `-WriteUrl`, `-DataDir`, `-SkipDoctor`, and `-NoCredentialPrompt`. Origins must have no path, query, fragment, or embedded credentials. Use HTTPS; HTTP is accepted only for loopback development. Account and user names contain 1–64 letters, digits, periods, underscores, or hyphens, beginning with a letter or digit.

The default data directory is `%LOCALAPPDATA%/CodexOpenVikingMemory`. Choose a private local directory outside the repository if overriding it. The installer discovers absolute Node/PowerShell paths, copies allowlisted runtime files, protects the secret directory ACL, and prompts locally without echoing the API key. An existing configuration or key is preserved, or incompatible reuse is rejected rather than silently overwritten.

For an offline packaging smoke test, use a new temporary directory with `-SkipDoctor -NoCredentialPrompt`. This does not provision a usable credential or establish readiness. Run a normal credential-provisioning install and `doctor` before actual use.

## Files outside the checkout

```text
CodexOpenVikingMemory/
  config.json
  runtime/                         # copied application source and pinned vendor source
  secrets/api-key.dpapi             # current Windows user's DPAPI protection
  secrets/vault-key.dpapi           # random local candidate encryption key
  candidate-vault/                  # encrypted candidates and local decisions
  approved-hook-data/               # restricted capture working data
  state/readiness.json
  marketplace/plugins/codex-openviking-memory/
  mcp-config.toml
  AGENTS.fragment.md
```

Use the actual generated layout and paths printed by the installer. DPAPI ties secrets to the Windows user. Copying encrypted files to another machine or account does not create a portable credential backup. Approved capture working data can contain sensitive summaries; the data directory needs the same care as other private application data.

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

`dataDir` must be absolute. `writeUrl` defaults to `serverUrl`. Read roots are derived from the user, not independently configurable:

- `viking://user/example-user/memories/`
- `viking://user/example-user/resources/personal-context/`

Environment overrides `OVCM_API_KEY` and `OVCM_VAULT_KEY` exist for isolated CI/non-Windows execution. The vault key is a base64-encoded 32-byte key. They are not the preferred Windows secret store, and the Windows installer remains the supported provisioning path. Never persist these environment values in project configuration, scripts, logs, or issue reports.

## Activate in your client

1. Locate the generated `.agents/plugins/marketplace.json` and plugin directory printed by the installer. Add this local marketplace using your client's plugin management interface and enable `codex-openviking-memory`.
2. Import the generated `mcp-config.toml` snippet into the appropriate Codex MCP configuration. It starts the installed Node CLI with `mcp --config` and an absolute configuration path. Keep an existing configuration and merge the new server entry carefully.
3. Reload as required by your client. Confirm the plugin supplies both `UserPromptSubmit` and `Stop`, and that the MCP server exposes only the eight documented tools.
4. Run the installed CLI's `doctor --config <path>` and resolve any identity/readiness failure.
5. Send a harmless message and inspect client hook status. If a save choice is offered, use only sample information until you have verified the entire local workflow.

The installer generates configuration but does not edit the user's existing Codex config or global instructions. The CLI injects review instructions through the hook response; `AGENTS.fragment.md` is supportive documentation you may add deliberately. Plugin discovery, hook support, MCP setup, and native question tools vary by client and version. The project cannot create a native question tool or guarantee its availability outside a supported client mode.

Official references: [Codex plugins](https://developers.openai.com/codex/plugins/) and [Codex MCP](https://developers.openai.com/codex/mcp/). Consult your installed client's documentation for its exact activation UI; these links are references, not evidence of universal feature availability.

## Confirm and verify

The model should show a candidate's actual ID, summary, and kind. When a native choice tool is unavailable or its output is unsupported, use the explicit single-message fallback `save candidate ID` or `保存候选 ID`. A reply such as “yes”, a pasted tool result, or a quoted command should not be treated as permission.

After the next `Stop` event, run `status --config <path> --id <actual-id>`. A submitted batch may still be queued or extracting. Use read-only MCP to verify the expected memory content after server processing. Do not infer successful indexing from a local approval, a submitted task ID, or a clean `doctor` result.
