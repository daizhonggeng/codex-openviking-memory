# Testing and limits

Run the suite with Node.js 22+:

```powershell
node --test
npm run verify:vendor
```

The test suite uses built-in `node:test`, isolated OS temporary directories, fake responses, and mock transport. No production credential or live account is needed. Windows native smoke tests require Windows and PowerShell 7; macOS native tests require macOS Keychain. Inspect test output for platform skips.

CI is configured for Node.js 22/24 on Linux, Windows, and macOS. Native tests must execute on their actual operating system; a Windows or Linux run that skips macOS tests is not evidence of Keychain correctness. The workflow configuration itself is not a passing result. Check the particular CI run before reporting a release as verified.

Tests are intended to cover:

- Candidate schema, encrypted local persistence, explicit approval, expiry, missing/submitted candidates, and duplicate prevention.
- Ordinary account/user identity enforcement, read-root scope, read-only MCP tools, list-only search, and rejection of cross-user/write requests.
- Capture transport restrictions, selected-summary-only upload, failure behavior, and child-process environment boundaries.
- Clean offline installation, source copying, generated hook/MCP configuration, and existing state/configuration preservation.
- Template initialization, preservation of user-edited files, safe destination paths, and separation of local mapping from remote import/upload.
- Windows DPAPI credential loading and macOS native Keychain roundtrips using synthetic secrets; macOS installation followed by installed-runtime proposal/status in an isolated test keychain.
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
9. Inspect the initialized `knowledge/` template and map. Edit a synthetic core file, initialize again, and verify the edit survives without a resource upload.

## Native credential test isolation

macOS tests must create a temporary isolated keychain, use synthetic API/vault keys, and point both the installer (`--keychain`) and installed runtime (`OVCM_KEYCHAIN_PATH`) at it. Cleanup may delete only those exact test-created items/keychain. Never reuse the login keychain or production credentials. API/vault secret values must not appear in process arguments, plaintext fixtures, or logs.

Windows tests use temporary application-data roots and synthetic credentials protected with CurrentUser DPAPI. Existing application configuration and personal data must remain untouched. The unified installer's pure argument-validation tests can run on other platforms, but they do not replace native tests.

Automated tests and native credential smoke tests do not establish a fresh real-user end-to-end deployment. Do not describe a mocked write or local Keychain roundtrip as successful production extraction/indexing.
