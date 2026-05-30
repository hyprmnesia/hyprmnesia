# hyprmnesia

## 0.5.1

### Patch Changes

- [#74](https://github.com/hyprmnesia/hyprmnesia/pull/74) [`c6b0cab`](https://github.com/hyprmnesia/hyprmnesia/commit/c6b0cabbf786d8521c0b6823b6d49d09edfc718a) Thanks [@julpel8](https://github.com/julpel8)! - Add native macOS OCR through Apple Vision so the automatic OCR engine works without Tesseract.

## 0.5.0

### Minor Changes

- [#70](https://github.com/hyprmnesia/hyprmnesia/pull/70) [`928fbbb`](https://github.com/hyprmnesia/hyprmnesia/commit/928fbbba0c745e5ffa1fd0302bb9c0ef486375ec) Thanks [@julpel8](https://github.com/julpel8)! - Store new capture blobs in lossy formats by default: screenshots use WebP and audio chunks use WebM/Opus, with WAV/PNG/JPEG remaining available for compatibility.

- [#71](https://github.com/hyprmnesia/hyprmnesia/pull/71) [`949796a`](https://github.com/hyprmnesia/hyprmnesia/commit/949796aea9d771d40e39e1cfdb40fc2d0cbfa19d) Thanks [@julpel8](https://github.com/julpel8)! - Add update notifications via GitHub Releases.

  - **`hpm update [--check] [--json]`**: checks GitHub for a newer release and
    reports it. Notification-only — it never downloads or installs anything.
    `--json` prints the machine-readable status.
  - **Automatic notice on `hpm start`**: after the daemon is spawned, a one-line
    notice is shown when a newer release exists. It reads from a daily cache
    (`~/.hyprmnesia/update-check.json`) with ETag-based conditional requests, runs
    with a short timeout, and never blocks capture or fails startup.
  - **Opt-out**: the automatic check is skipped under `HPM_NO_UPDATE_CHECK=1`,
    `CI=1`, or `update.check: false` in `config.yaml`. `hpm update` always checks
    on demand regardless.

## 0.4.1

### Patch Changes

- [#67](https://github.com/hyprmnesia/hyprmnesia/pull/67) [`d57296e`](https://github.com/hyprmnesia/hyprmnesia/commit/d57296e7ddb02bd45f00678912d15cf3b1bdc394) Thanks [@julpel8](https://github.com/julpel8)! - Document the release checklist and PR changeset requirement.

- [#68](https://github.com/hyprmnesia/hyprmnesia/pull/68) [`fc8ef13`](https://github.com/hyprmnesia/hyprmnesia/commit/fc8ef13261d73127af57cc59549ea9f884b04282) Thanks [@julpel8](https://github.com/julpel8)! - Simplify the app logo to a plain blue H on black and use native-style macOS/Linux tray status icons.

## 0.4.0

### Minor Changes

- [#64](https://github.com/hyprmnesia/hyprmnesia/pull/64) [`571d4df`](https://github.com/hyprmnesia/hyprmnesia/commit/571d4df556f1868e076dd0ab10ce4acb96e17606) Thanks [@julpel8](https://github.com/julpel8)! - Add user controls and automatic migration for encryption at rest.

  - **Per-surface config flags**: `storage.encryption.database` and
    `storage.encryption.blobs` (both default true) replace the single
    `storage.encryption.enabled` flag, which is migrated automatically.
  - **Automatic blob migration**: on daemon startup a one-time, marker-guarded
    background sweep encrypts pre-existing plaintext blobs in place (atomic rename,
    resumable, restricted to the capture-kind subdirectories so it never touches
    the index DB or other files).
  - **Encrypt-only daemon**: turning a flag off makes new data plaintext while
    existing encrypted data stays readable via the keychain key; the daemon never
    auto-decrypts.
  - **CLI commands**: `hpm encrypt [--db] [--blobs]` and
    `hpm decrypt [--db] [--blobs]` (no scope flag = both) convert data in place,
    persist the matching config flags, and refuse to run while the daemon is alive.

### Patch Changes

- [#62](https://github.com/hyprmnesia/hyprmnesia/pull/62) [`c1930ef`](https://github.com/hyprmnesia/hyprmnesia/commit/c1930ef9aa0a615469e6bc0c1c8d2d48e3a909cd) Thanks [@julpel8](https://github.com/julpel8)! - Replace the app and tray logos with Hyprmnesia-branded assets, including the Windows executable and installer icon.

## 0.3.1

### Patch Changes

- [#60](https://github.com/hyprmnesia/hyprmnesia/pull/60) [`fc080ed`](https://github.com/hyprmnesia/hyprmnesia/commit/fc080edc542df44bb16f065ed08637db7c2b52e2) Thanks [@julpel8](https://github.com/julpel8)! - Add follow-up regression tests for blob storage, sqlite-vec, replay manifests, window tracking, and native sidecar helpers.

## 0.3.0

### Minor Changes

- [#58](https://github.com/hyprmnesia/hyprmnesia/pull/58) [`fd75eb7`](https://github.com/hyprmnesia/hyprmnesia/commit/fd75eb739ee48553308291194db24336f6289f5b) Thanks [@julpel8](https://github.com/julpel8)! - Encrypt captured blob files (screenshots & audio) at rest with AES-256-GCM.

  New blobs written under `storage.path` are sealed in a whole-file AEAD envelope
  using an HKDF-derived subkey of the existing index master key (one OS-keychain
  entry, gated by the existing `storage.encryption.enabled` flag). The replay
  server decrypts blobs in memory and remains Range-aware (audio scrubbing still
  works), and MCP `recall(include_blob)` returns the decrypted bytes inline as
  `blob_base64` with `encrypted: true`. Legacy plaintext blobs are detected by a
  magic header and read transparently, so encrypted and plaintext captures coexist
  with no migration.

## 0.2.0

### Minor Changes

- [#56](https://github.com/hyprmnesia/hyprmnesia/pull/56) [`e90fc0d`](https://github.com/hyprmnesia/hyprmnesia/commit/e90fc0d82487c3cb4c9db7dafddc3c7c273e8907) Thanks [@julpel8](https://github.com/julpel8)! - Encrypt the index DB at rest. `index.db` (OCR text, window titles, URLs, transcripts) is now stored with SQLCipher-style page-level encryption via SQLite3MultipleCiphers, loaded through `bun:ffi` so it works on Windows, Linux, and macOS under the compiled binary. The 256-bit master key lives in the OS keychain (DPAPI / Keychain / Secret Service) so the background daemon restarts without a prompt, and an existing plaintext `index.db` is migrated in place on first start. FTS5 and semantic (vec0) search keep working. Enabled by default; set `storage.encryption.enabled: false` to opt out. Blob files (screenshots/audio) are tracked separately in [#54](https://github.com/hyprmnesia/hyprmnesia/issues/54).

## 0.1.4

### Patch Changes

- [#53](https://github.com/hyprmnesia/hyprmnesia/pull/53) [`4eddc00`](https://github.com/hyprmnesia/hyprmnesia/commit/4eddc00025e538020d0809ba7191623a3713980d) Thanks [@julpel8](https://github.com/julpel8)! - Make Quit Hyprmnesia stop the daemon before exiting the tray.

## 0.1.3

### Patch Changes

- [#51](https://github.com/hyprmnesia/hyprmnesia/pull/51) [`f5e3881`](https://github.com/hyprmnesia/hyprmnesia/commit/f5e388152f049cfb4e087ba9079c159f62542cdc) Thanks [@julpel8](https://github.com/julpel8)! - Require pull requests to include at least one changeset so release notes stay complete.

## 0.1.2

### Patch Changes

- [#33](https://github.com/hyprmnesia/hyprmnesia/pull/33) [`6ac4796`](https://github.com/hyprmnesia/hyprmnesia/commit/6ac479688e011687415c4280cd92e76e0748aa30) Thanks [@julpel8](https://github.com/julpel8)! - Add a dummy changeset for main PR workflow testing.

## 0.1.1

### Patch Changes

- [#30](https://github.com/hyprmnesia/hyprmnesia/pull/30) [`d1fbb4f`](https://github.com/hyprmnesia/hyprmnesia/commit/d1fbb4f7d3179e84881d6adb21322892dd07ad68) Thanks [@julpel8](https://github.com/julpel8)! - Publish the GitHub release automatically when the Changesets version PR is merged.

## 0.1.0

### Minor Changes

- [#20](https://github.com/hyprmnesia/hyprmnesia/pull/20) [`f9fa942`](https://github.com/hyprmnesia/hyprmnesia/commit/f9fa942350f9d4c6e7fd4e7d4771d62b26230bcb) Thanks [@julpel8](https://github.com/julpel8)! - Fixes from the review of [#20](https://github.com/hyprmnesia/hyprmnesia/issues/20).
  - MCP: pre-warm + retry the embedding worker (no more "disabled for the session" after one transient failure).
  - wlcap: post EOS on `Capture::close` so the bus watcher exits.
  - WASAPI: stop exiting on the 2 s event-wait timeout — shared-mode loopback only produces packets while audio is rendering, so silence was killing the capture; keep waiting instead.
  - WASAPI: emit silent PCM across loopback timeouts so system-audio chunks still rotate at the configured duration while the system is silent.
  - WASAPI resampler: split down/upsampling paths; drop dead `unwrap_or`.
  - `chunks_au` trigger: skip re-index when only non-FTS columns change.
  - hpm-embed: truncate tokenizer input to the model's position-embedding limit so long chunks no longer crash the ONNX Add node.
