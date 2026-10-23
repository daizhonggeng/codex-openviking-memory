# Testing and limits

Run the suite with Node.js 22+:

```powershell
node --test
npm run verify:vendor
```

The test suite uses built-in `node:test`, isolated OS temporary directories, fake responses, and mock transport. No production credential or live account is needed. Installer smoke tests require Windows and PowerShell 7; inspect test output for platform skips.

Tests are intended to cover:

- Candidate schema, encrypted local persistence, explicit approval, expiry, missing/submitted candidates, and duplicate prevention.
- Ordinary account/user identity enforcement, read-root scope, read-only MCP tools, list-only search, and rejection of cross-user/write requests.
- Capture transport restrictions, selected-summary-only upload, failure behavior, and child-process environment boundaries.
- Clean offline installation, source copying, generated hook/MCP configuration, and existing state/configuration preservation.
- CLI integration using temporary configuration and fake server responses.

Read the actual test output and named tests for the currently executed coverage. A passing suite does not establish live OpenViking API compatibility, operating-system hardening against a hostile local user, successful server indexing, or all Codex client versions' support for hooks and native question tools.

## Manual acceptance in a dedicated test account

1. Use a new data directory, an ordinary disposable test identity, and non-sensitive sample facts.
2. Install normally and ensure `doctor` succeeds for the exact identity.
3. Enable the generated plugin and MCP configuration in the target client; verify both hooks run.
4. Confirm that an ordinary message causes semantic review, while a transient request need not create a candidate.
5. Create a sample candidate; confirm that it is local before human approval.
6. Test the client's native question tool if available, and separately test exact typed confirmation.
7. Allow the `Stop` event; inspect `status`, task metadata, and the resulting scoped memory via read-only MCP.
8. Verify that an unselected candidate was not submitted and that cross-user read attempts fail.

This repository's initial release has not yet completed that fresh real-user acceptance path. Do not describe mocked tests as a successful production installation.
