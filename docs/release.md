# Release Process

> Back to the [README](../README.md).

Hyprmnesia uses Changesets for version/changelog management and GitHub Actions
for multi-OS installer builds. Releases are intentionally unsigned during alpha.

## 1. Add a changeset

For any user-visible change:

```sh
bun run changeset
```

Pick the appropriate bump and write a concise note. Commit the generated file
under `.changeset/`.

## 2. Merge the version PR

When changesets land on `main`, the `Release PR` workflow opens or updates a
`chore: version packages` PR. That PR runs:

```sh
bun run version-packages
```

It updates `package.json`, `CHANGELOG.md`, Rust crate versions, `Cargo.lock`,
and `src/version.ts`.

## 3. Tag the release

After merging the version PR, create and push a matching tag:

```sh
git checkout main
git pull
git tag v0.1.0
git push origin v0.1.0
```

The tag must match `package.json.version`, including the leading `v`.

## 4. Verify artifacts

The `Release` workflow builds on Windows, macOS, and Ubuntu. It publishes:

- Windows MSI and portable zip
- macOS PKG and portable tarball
- Debian/Ubuntu DEB and portable tarball
- `SHA256SUMS`

Before tagging a real release, run the `Release` workflow manually with
`workflow_dispatch` to produce dry-run artifacts without publishing a GitHub
Release.

## Signing

Code signing and notarization are not part of alpha releases. Track that work in
the GitHub issue `Code signing and notarization for installers`.
