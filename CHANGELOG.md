# hyprmnesia

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
