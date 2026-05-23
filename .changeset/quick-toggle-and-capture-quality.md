---
"hyprmnesia": minor
---

Add quick capture toggles and configurable capture quality.

- TUI keys `s` / `m` / `y` toggle screen, mic, and system capture on/off; the
  change is saved to config and the daemon restarts to apply it when running.
- New `capture.screen.quality` (JPEG quality) and `capture.screen.max_width`
  (resolution downscale) settings, exposed in the TUI settings panel and via the
  `--screen-quality` / `--screen-max-width` flags. Quality is applied through
  ScreenCaptureKit on macOS and an ffmpeg re-encode on Windows/Linux.
