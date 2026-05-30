---
"hyprmnesia": minor
---

Add update notifications via GitHub Releases.

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
