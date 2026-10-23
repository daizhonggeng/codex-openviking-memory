# Pinned OpenViking source

This directory packages **30 unchanged upstream source/license files** from the OpenViking Codex memory example. It intentionally omits the server distribution and any private local deployment data.

| Field | Value |
| --- | --- |
| Project | OpenViking |
| Repository | https://github.com/volcengine/OpenViking |
| Release/tag | `v0.5.1.1` |
| Git tree | `c2dea8005f851ce064223b78c2c7d5634807b9fb` |
| Tree permalink | https://github.com/volcengine/OpenViking/tree/c2dea8005f851ce064223b78c2c7d5634807b9fb |
| License | GNU Affero General Public License v3; this distribution uses `AGPL-3.0-only` |
| Upstream files | `OpenViking-v0.5.1.1/LICENSE`, plugin metadata, and 28 `.mjs` files |
| Integrity record | `SHA256SUMS` |
| Machine-readable provenance | `UPSTREAM.json` (repository, ref, tree, license, and SHA-256 file map) |

All listed file bytes were checked against their pinned upstream Git blob IDs when packaged. `SHA256SUMS` records an additional SHA-256 digest for each file, with paths relative to `vendor/`. `SHA256SUMS`, `UPSTREAM.json`, and this README are packaging metadata outside the pinned source tree. The original license text is retained unchanged, including at the repository root. See [NOTICE](../NOTICE).

The pinned example's `plugin.json` declares `Apache-2.0`, while the pinned upstream root `LICENSE` contains GNU AGPL v3. This metadata discrepancy is retained and disclosed rather than edited away. This integration is distributed as `AGPL-3.0-only` and does not claim a permissive relicensing based on the plugin metadata.

The wrapper runs the official capture path with its own approval and transport boundaries. Do not install the vendor plugin directly: its standalone behavior is not this project's human-confirmation workflow. Unused upstream helper modules remain present to preserve the pinned, auditable source subset; their presence does not expose additional MCP tools.

Run `npm run verify:vendor` from the repository root. To independently verify hashes in PowerShell 7:

```powershell
$vendorRoot = (Resolve-Path ./vendor).Path
$entries = Get-Content (Join-Path $vendorRoot SHA256SUMS)
foreach ($entry in $entries) {
  $expected, $relative = $entry -split '  ', 2
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $vendorRoot $relative)).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Vendor hash mismatch: $relative" }
}
```

For a future update, obtain the matching upstream source, review its license and capture dependencies, replace the source in a dedicated change, and regenerate provenance/hashes. Do not edit individual upstream files in place or copy an entire personal installation into this directory.
