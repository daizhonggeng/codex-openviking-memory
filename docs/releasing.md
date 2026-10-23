# Release checklist

- [ ] Run `node --test` on the Node.js 22/24 CI matrix; record platform skips and the exact workflow run.
- [ ] Require native macOS Keychain and installed-runtime smoke tests to pass on a macOS runner, plus native Windows DPAPI installer tests on Windows. Local skips do not satisfy this gate.
- [ ] Verify the repository contains no credentials, personal config/state, candidates, approved summaries, logs, backups, or machine-specific paths/private hostnames.
- [ ] Check the tracked file list and packaged file list. Runtime data belongs outside the checkout; `.gitignore` is not proof that previously tracked data is absent.
- [ ] Recompute all 30 vendored file SHA-256 values against `vendor/SHA256SUMS` and confirm the pinned Git tree/source URL.
- [ ] Retain both copies of the upstream AGPL license, attribution, provenance, and corresponding source. Record any future vendor update as a separate reviewed change.
- [ ] Confirm README, CLI help, generated installer output, configuration schema, and supported native-confirmation behavior agree.
- [ ] Verify unified installer flags on both platforms, existing v0.1 schema compatibility, and local template initialization/preservation.
- [ ] Inspect `templates/personal-context/` for filled facts, historical dates, private project names, credential/service settings, and inherited Git/sync policy. Keep only generic blank structure.
- [ ] Confirm `template init`/`template map` require no credentials/network and perform no import, remote creation, upload, or Git knowledge persistence.
- [ ] Identify remaining manual acceptance gaps. Do not claim live extraction/indexing success from mock tests or task submission alone.
- [ ] Update the version/release notes; inspect the exact diff and archive contents before creating the public tag/release.
- [ ] Publish only after the owner has authorized the external write. Do not include private local installation data in release assets.
