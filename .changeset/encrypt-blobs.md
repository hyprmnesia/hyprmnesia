---
"hyprmnesia": minor
---

Encrypt captured blob files (screenshots & audio) at rest with AES-256-GCM.

New blobs written under `storage.path` are sealed in a whole-file AEAD envelope
using an HKDF-derived subkey of the existing index master key (one OS-keychain
entry, gated by the existing `storage.encryption.enabled` flag). The replay
server decrypts blobs in memory and remains Range-aware (audio scrubbing still
works), and MCP `recall(include_blob)` returns the decrypted bytes inline as
`blob_base64` with `encrypted: true`. Legacy plaintext blobs are detected by a
magic header and read transparently, so encrypted and plaintext captures coexist
with no migration.
