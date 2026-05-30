# Release Process

> Back to the [README](../README.md).

Hyprmnesia uses Changesets for version and changelog management, plus GitHub
Actions for version PRs, installer builds, release notes, and published release
assets. Releases are intentionally unsigned during alpha.

## Release checklist

### 1. Add a changeset to every PR

Every human-authored PR must include at least one `.changeset/*.md` file:

```sh
bun run changeset
```

Pick the appropriate bump, write a concise release note, and commit the
generated file with the PR. The CI `Changeset` job blocks PRs that do not touch
`.changeset/*.md`. The only exception is the automated release branch
`changeset-release/main`, which is created by Changesets.

### 2. Let Changesets open the version PR

When changesets land on `main`, the `Release PR` workflow opens or updates an
automated PR titled `chore: version packages`. That PR runs:

```sh
bun run version-packages
```

The command applies all pending changesets and updates:

- `package.json`
- `CHANGELOG.md`
- Rust crate versions
- `Cargo.lock`
- `src/version.ts`

Review the generated changelog and version changes, then merge the PR when the
release is ready.

### 3. Publish the release

Merging the `changeset-release/main` version PR triggers the `Release` workflow.
The workflow builds Windows, macOS, and Ubuntu artifacts, prepares release notes
from `CHANGELOG.md`, writes checksums, and creates or updates the GitHub Release
for the package version tag, such as `v0.4.1`.

The release workflow can also run from a pushed `vX.Y.Z` tag:

```sh
git checkout main
git pull
git tag v0.4.1
git push origin v0.4.1
```

For tag-triggered releases, the tag must match `package.json.version` with a
leading `v`.

### 4. Verify artifacts

The published GitHub Release should include:

- Windows MSI and portable zip
- macOS PKG and portable tarball
- Debian/Ubuntu DEB and portable tarball
- `SHA256SUMS`

Before publishing a real release, run the `Release` workflow manually with
`workflow_dispatch` to produce dry-run artifacts without publishing a GitHub
Release. Download and smoke-test those artifacts if the change touches build,
packaging, installer, or platform-specific behavior.

## Signing

Code signing and notarization are not part of alpha releases. Track that work in
the GitHub issue `Code signing and notarization for installers`.
