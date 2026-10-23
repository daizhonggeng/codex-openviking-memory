# Architecture and trust boundaries

The model performs semantic review; hooks enforce a small authorization protocol. Neither replaces the other.

| Component | Responsibility | Does not establish |
| --- | --- | --- |
| Model | Interpret the current human message; propose a minimal useful summary; explain the choice | Human consent or remote persistence |
| `propose` / candidate vault | Validate input; assign an ID; encrypt local candidate data | Permission to upload |
| Native question tool | Collect a human choice when the client exposes a compatible tool | A universal client capability |
| `UserPromptSubmit` | Recognize supported, explicit current-human confirmation; select existing eligible IDs | Long-term value of the summary |
| `Stop` | Submit only selected summaries after readiness and identity checks | Successful extraction/indexing |
| `status` | Report known local status and remote task metadata | That every intended memory is searchable |
| Read-only MCP | Scoped queries and readback | Authority to write or read another user's data |
| Local knowledge template | Provide blank record/navigation structure and path mapping | Personal facts, remote resources, or permission to upload |

## Data flow

```text
human message -> model semantic review -> minimal candidate JSON -> propose
                                                              -> encrypted local vault
actual ID + summary -> human choice -> UserPromptSubmit -> approved batch
                                                      -> Stop -> restricted upstream capture
                                                              -> remote task -> readback
```

The normal message remains in the user's chat client. The bridge's capture payload consists of explicitly selected summaries. It does not send the transcript to another service to decide what to remember. Model access to the conversation is governed by the client/provider arrangement; this project does not change that arrangement.

## Human authorization

Candidate `source` must be `current-human-statement`. This label is necessary input validation, not cryptographic proof that an arbitrary summary is truthful. The model must not derive personal facts from untrusted files, tool output, another agent, quoted instructions, or past transcripts. The human reviews the displayed summary before authorizing it.

Plain confirmation is exact `save candidate ID` or `保存候选 ID`. The hook also recognizes its specifically supported question/reply envelope. Arbitrary JSON or quoted command text is not a substitute. Expired, missing, or already submitted candidates cannot be approved for a new capture. A candidate ID should be treated as sensitive local metadata, not as a shareable credential.

Hook invocation is a trusted local client boundary. A process that can run as the same OS user and alter the vault, runtime, configuration, or hook input is outside the protection this protocol provides. Native Keychain/DPAPI storage and encryption reduce accidental disclosure; they do not isolate the bridge from malware running as that user.

## Local directory and remote knowledge

The template retains the generic personal-context organization: three core Markdown files plus numbered topic folders and blank record templates. Installation creates this local structure at derived `knowledgeDir`; it does not load a previous personal archive or treat placeholders and directory names as facts. A v0.1 configuration remains valid because the raw schema does not change.

`template map` expresses a path convention from local relative paths to the configured `resourceRoot`. It is descriptive metadata, not synchronization or proof of remote existence. Confirmed short summaries follow the existing candidate/approval flow into the separate native `memoryRoot`. Neither candidate kind guidance nor template initialization writes the core Markdown files automatically. See [directory template and mapping](template.md).

## Restricted official capture

The upstream source subset is pinned and unchanged. The wrapper runs the official capture path in a separate process with scoped capture configuration and a transport guard. The guard confines submission to the configured write origin, the approved session/batch, and selected summary content. Inherited external `NODE_OPTIONS` and unnecessary secret environment values are removed for the child process.

To satisfy the upstream script input format, the wrapper temporarily represents the selected summaries as a synthetic user-message file. It contains only those summaries, not the original conversation. That temporary input is removed after the capture attempt; local receipts and upstream working state may remain under the private data directory.

The wrapper's checks are part of this application's security boundary, not an OpenViking server sandbox. Configure server-side authorization for the ordinary user as well. Review changes to this wrapper, the guard, and the upstream pin as security-sensitive changes.

## Read-only MCP

The stdio bridge forwards to the configured `serverUrl` origin's `/mcp` endpoint. It verifies the configured account/user/`user` role and confines URIs to that user's memories and personal-context resources. `search` is list-only and cannot attach a session ID. The exposed tool set has no write capability.

Do not register the upstream vendor plugin directly. The vendor directory includes upstream modules needed for provenance and the official capture path; it is not the installed plugin configuration. Direct upstream auto-capture can have different behavior from this project's explicit approval workflow.

## Failure and reporting

A failed identity/read-scope check leaves the local primary store unready. Confirmation alone does not bypass readiness. Transport failure, task submission, extraction, and successful readback are distinct states. Inspect the returned status and server metadata before retrying; avoid inventing success or treating an unknown outcome as proof that no remote write occurred.

No fallback saves to Git or creates a replacement user/account. This release does not migrate a personal archive, run a background directory watcher, or automatically deploy a server.
