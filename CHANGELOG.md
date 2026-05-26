# hyprmnesia

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
