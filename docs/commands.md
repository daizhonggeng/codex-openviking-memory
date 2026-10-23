# Command reference

Run `node bin/cli.mjs --help` from the checkout, or replace the script path with the installed runtime path. Supply the installer-generated configuration explicitly when using a nondefault location.

| Command | Purpose |
| --- | --- |
| `propose --config PATH --input FILE` | Validate a three-field candidate JSON, save locally, and return its actual ID/status/kind |
| `hook UserPromptSubmit --config PATH` | Read a client hook event from stdin; return hook instructions/confirmation outcome |
| `hook Stop --config PATH` | Process the approved local batch through the guarded writer |
| `doctor --config PATH` | Authenticate, verify exact ordinary identity/read scope, and establish local readiness on success |
| `status --config PATH --id ID` | Report local status and known remote task metadata without printing the candidate summary |
| `mcp --config PATH` | Start the read-only JSON-RPC stdio MCP server |
| `template init --config PATH [--directory PATH]` | Create missing local template files; preserve existing files; return created/skipped paths |
| `template map --config PATH [--directory PATH]` | Describe local template paths and their remote resource URI convention |
| `--help` | Display CLI usage |

The hook commands are client integration entry points invoked by the trusted host runtime. The assistant must never self-invoke either hook to create confirmation or trigger submission. Do not forge hook events to bypass a human choice. The `mcp` command speaks a protocol over stdio; it is not an interactive chat prompt.

## Directory template

`template init` and `template map` require valid configuration but no API/vault credentials and no network. Their default directory is derived as `dataDir/knowledge`; `--directory` selects an explicit local destination. Initializing again fills missing template files and skips existing ones, including edited core files. It does not overwrite, import, upload, or initialize Git persistence. Initialization refuses unsafe paths and symlinks rather than following them.

`template map` returns JSON describing the template version, local root, configured resource and native-memory roots, core-file mapping, and topic-directory mapping. The result is a navigation convention; it does not query or create corresponding remote objects. See [the full template guide](template.md).

## Candidate input

```json
{
  "summary": "A short fact the current human explicitly stated and wants considered.",
  "kind": "knowledge",
  "source": "current-human-statement"
}
```

Use only `summary`, `kind`, and `source`. Kinds: `profile`, `preference`, `current`, `knowledge`. Exclude credentials, identification numbers, financial account numbers, chat transcripts, and logs. The model should propose at most three useful candidates per normal message and skip transient requests or unsupported inferences. Candidate validation is a boundary check; human review remains essential.

Summaries must contain 2–2000 characters. Candidates expire seven days after creation; approval does not extend that lifetime. Expiry prevents a later submission but does not automatically remove the encrypted local record. Treat retention and backups as local application-data management.

The temporary input file is plaintext. Keep it outside the repository, restrict access, and remove it after successful proposal when no longer needed. The returned candidate ID must come from the tool; never present a placeholder as an approvable ID.

## Confirmation

Send one exact human message, replacing the ID:

```text
save candidate ACTUAL_CANDIDATE_ID
```

or:

```text
保存候选 ACTUAL_CANDIDATE_ID
```

The application may recognize a compatible native question-card reply. It does not provide a native UI tool. When a client cannot supply a supported question reply, use the exact text form. A local candidate remains local until confirmation and the subsequent `Stop` submission.

## Status and readback

`status` reports only what the local vault and available remote task metadata establish. Approval is not submission; submission is not extraction; extraction metadata is not a substitute for reading the resulting memory. Use the configured read-only MCP tools to locate and read the expected summary before claiming end-to-end success.

If status reports a failure, resolve configuration/identity/transport problems first. Do not repeatedly approve the same ID or assume every retry is safe after an uncertain network outcome. Preserve local state while investigating.
