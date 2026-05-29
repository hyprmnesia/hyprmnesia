// Whole-file AES-256-GCM encryption for captured blobs (screenshots & audio).
// The index DB is already encrypted (#12 / PR #56); this is the blob half (#54).
//
// We encrypt each blob file as a single AEAD envelope rather than streaming in
// chunks: blobs are small (audio chunks ~5s, screenshots a few MB) and the only
// reader that needs byte ranges is the localhost replay server, which can afford
// to decrypt the whole file in memory and slice. This keeps us on node:crypto
// (no native dependency, works under `bun build --compile`).
//
// File layout:
//   [ magic 4B "HPMB" ][ version 1B ][ IV 12B ][ ciphertext ][ GCM tag 16B ]
//
// The key is an HKDF-SHA256 subkey of the index master key (see db_key.ts), so
// the two cipher constructions never share raw key material and we keep a single
// OS-keychain entry.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

// "HPMB" — chosen so it never collides with the leading bytes of the formats we
// store (PNG `\x89PNG`, JPEG `\xFF\xD8`, WAV `RIFF`), which lets readers tell an
// encrypted blob from a legacy plaintext one by inspecting the first 4 bytes.
const MAGIC = Buffer.from('HPMB', 'ascii')
const VERSION = 1
const IV_LEN = 12
const TAG_LEN = 16
const HEADER_LEN = MAGIC.length + 1 + IV_LEN // magic + version + iv = 17

// Domain-separation label so the blob key is cryptographically independent from
// the SQLCipher index key derived from the same master.
const BLOB_KEY_INFO = 'hyprmnesia-blob-v1'

// HKDF-SHA256 subkey (32 bytes for AES-256) of the index master key. Empty salt:
// the master is already a uniformly random 256-bit secret, and `info` provides
// the separation we need.
export function deriveBlobKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), BLOB_KEY_INFO, 32))
}

export function encryptBlob(key: Buffer, plaintext: Buffer): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, body, tag])
}

// True when `buf` carries our magic header and is long enough to hold an IV+tag.
export function isEncryptedBlob(buf: Buffer): boolean {
  return buf.length >= HEADER_LEN + TAG_LEN && buf.subarray(0, MAGIC.length).equals(MAGIC)
}

export function decryptBlob(key: Buffer, file: Buffer): Buffer {
  if (!isEncryptedBlob(file)) throw new Error('not an encrypted hyprmnesia blob')
  const version = file[MAGIC.length]
  if (version !== VERSION) throw new Error(`unsupported blob encryption version ${version}`)
  const iv = file.subarray(MAGIC.length + 1, HEADER_LEN)
  const tag = file.subarray(file.length - TAG_LEN)
  const body = file.subarray(HEADER_LEN, file.length - TAG_LEN)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

// Reads a blob from disk and returns its plaintext. Encrypted blobs require
// `key`; legacy plaintext blobs (written before encryption, or with encryption
// disabled) are returned as-is, so readers transparently handle a mix of both.
export function readBlobFile(path: string, key?: Buffer): Buffer {
  const raw = readFileSync(path)
  if (!isEncryptedBlob(raw)) return raw
  if (!key) throw new Error(`blob ${path} is encrypted but no key is available`)
  return decryptBlob(key, raw)
}
