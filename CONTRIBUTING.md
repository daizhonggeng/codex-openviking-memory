# Contributing

Use Node.js 22+ and run `node --test` plus `npm run verify:vendor`. The runtime uses Node built-ins and ESM; keep changes small and avoid adding dependencies without a concrete need. Installer entry is `node scripts/install.mjs`. Windows work also requires PowerShell 7 and DPAPI smoke tests; macOS work requires native Keychain tests using an isolated temporary keychain and synthetic secrets. Linux unit-test results cannot verify a native credential implementation.

Discuss behavior changes that affect confirmation, identity, URI scope, credentials, upstream pinning, or capture payloads before broad implementation. These boundaries are part of the project's purpose. A pull request should describe the concrete trigger, resulting behavior, relevant test output, and remaining limitations.

Use synthetic examples and temporary directories. Never test a pull request against a real user's memory store, include production credentials, copy a private application-data directory, or commit sample transcripts. Tests must not upload data to a live endpoint.

Keep `templates/personal-context/` generic. Preserve the numbered personal-context layout and blank record formats without copying filled profile/preferences/current files, private project trees, dates, service configuration, or a prior installation's sync/write policies. Template initialization must preserve existing files and reject symlinks/traversal. A path map is not import or synchronization; changes must not add automatic resource uploads, Git knowledge persistence, or writes to user-filled Markdown.

Keep `vendor/OpenViking-v0.5.1.1/` upstream files byte-for-byte unchanged. For an upstream update, identify the source tag and Git tree, explicitly review the changed subset and license, regenerate hashes, and update provenance in a dedicated change. Implement integration behavior in the wrapper rather than silently patching vendor source.

Documentation must distinguish model semantic judgment from deterministic hook enforcement and local approval from submission/indexing/readback. Native question tools are a client capability and may be unavailable; exact typed confirmation is an explicit fallback, never implicit consent.

Hooks are invoked by the trusted client runtime. An assistant must not call a hook itself to create approval or trigger a write. Tests may simulate the host with synthetic input; production confirmation has no cryptographic human attestation against an attacker who can execute arbitrary local code as the same OS user.

Contributions are provided under this repository's AGPL-3.0-only license. Retain upstream notices and do not add code you lack the right to distribute under compatible terms. See [SECURITY.md](SECURITY.md) for vulnerability reporting rather than posting sensitive details in a public issue.
