---
"hyprmnesia": minor
---

Encrypt the index DB at rest. `index.db` (OCR text, window titles, URLs, transcripts) is now stored with SQLCipher-style page-level encryption via SQLite3MultipleCiphers, loaded through `bun:ffi` so it works on Windows, Linux, and macOS under the compiled binary. The 256-bit master key lives in the OS keychain (DPAPI / Keychain / Secret Service) so the background daemon restarts without a prompt, and an existing plaintext `index.db` is migrated in place on first start. FTS5 and semantic (vec0) search keep working. Enabled by default; set `storage.encryption.enabled: false` to opt out. Blob files (screenshots/audio) are tracked separately in #54.
