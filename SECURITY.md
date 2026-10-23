# Security and privacy

This bridge handles personal summaries and credentials. Use an ordinary OpenViking user and a private local data directory. Do not commit application state or put real data into test fixtures.

## Boundaries

- The model decides whether to propose a summary; the human decides whether it may be submitted. The hook accepts supported explicit confirmation and the writer runs only the approved batch.
- Read-only MCP confines queries to the configured identity's memories and personal-context resource subtree; the server must enforce authorization too.
- Windows DPAPI protects the API key and candidate vault key for the current Windows user. Candidate files are encrypted locally. Plaintext input and approved capture working data still require local access controls.
- The capture child process uses pinned upstream scripts with a restricted transport. Do not run the vendor plugin directly as a replacement for this project's approval hooks.
- `doctor` checks identity/read scope. It does not audit the server, guarantee source extraction, or prove that a selected client's hook integration is active.

The hook source is the trusted host runtime. The assistant must never self-invoke a hook to manufacture human confirmation or force submission. The protocol does not provide cryptographic human attestation against arbitrary local code execution.

A malicious process running as the same OS user may alter runtime/configuration, invoke hooks, read process memory, or access decrypted data. This project does not provide a separate OS security boundary. It also cannot guarantee model judgment, truthful candidate content, or privacy practices of the client/model provider or OpenViking deployment.

## Keep private

Never publish API keys, environment dumps, DPAPI blobs, vault keys, candidate files, approved summaries, hook payloads, transcripts, logs, backups, SSH configuration, or user-specific global rules. Redact account/user identifiers, hostnames, and data-directory paths when sharing diagnostics. Prefer `status` output to raw vault files, and inspect any output before posting it.

The public repository contains source, generic examples, mocked tests, and upstream provenance. Runtime data is generated outside the checkout. `.gitignore` is defense against accidental additions, not encryption or a substitute for reviewing tracked files and release archives.

## Reporting

For a suspected vulnerability, use the repository host's private vulnerability reporting feature if available. If it is unavailable, open an issue containing only a request for a private contact channel, without exploit details or sensitive data. Never post a credential or real candidate to demonstrate a bug.

Version 0.1.x is the initial supported release line. No response-time guarantee is offered. Include a minimal reproduction with synthetic data, affected version, platform, and the trust boundary involved. Credential exposure should also be handled by revoking/rotating the affected key at the server.
