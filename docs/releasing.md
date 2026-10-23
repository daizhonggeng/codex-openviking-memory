# Release checklist

- [ ] Run `node --test` on Node.js 22+; record platform skips and Windows installer smoke results.
- [ ] Verify the repository contains no credentials, personal config/state, candidates, approved summaries, logs, backups, or machine-specific paths/private hostnames.
- [ ] Check the tracked file list and packaged file list. Runtime data belongs outside the checkout; `.gitignore` is not proof that previously tracked data is absent.
- [ ] Recompute all 30 vendored file SHA-256 values against `vendor/SHA256SUMS` and confirm the pinned Git tree/source URL.
- [ ] Retain both copies of the upstream AGPL license, attribution, provenance, and corresponding source. Record any future vendor update as a separate reviewed change.
- [ ] Confirm README, CLI help, generated installer output, configuration schema, and supported native-confirmation behavior agree.
- [ ] Identify remaining manual acceptance gaps. Do not claim live extraction/indexing success from mock tests or task submission alone.
- [ ] Update the version/release notes; inspect the exact diff and archive contents before creating the public tag/release.
- [ ] Publish only after the owner has authorized the external write. Do not include private local installation data in release assets.
