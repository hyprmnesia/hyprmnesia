---
"hyprmnesia": minor
---

Add user controls and automatic migration for encryption at rest.

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
