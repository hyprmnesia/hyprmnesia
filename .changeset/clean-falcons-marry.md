---
"hyprmnesia": minor
---

Fixes from the review of #20.
- MCP: pre-warm + retry the embedding worker (no more "disabled for the session" after one transient failure).
- wlcap: post EOS on `Capture::close` so the bus watcher exits.
- WASAPI: stop exiting on the 2 s event-wait timeout — shared-mode loopback only produces packets while audio is rendering, so silence was killing the capture; keep waiting instead.
- WASAPI: emit silent PCM across loopback timeouts so system-audio chunks still rotate at the configured duration while the system is silent.
- WASAPI resampler: split down/upsampling paths; drop dead `unwrap_or`.
- `chunks_au` trigger: skip re-index when only non-FTS columns change.
- hpm-embed: truncate tokenizer input to the model's position-embedding limit so long chunks no longer crash the ONNX Add node.
