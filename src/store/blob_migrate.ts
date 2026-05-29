// One-time, in-place migration of pre-existing plaintext blobs to the encrypted
// format (#54). Captures written before encryption was enabled stay readable
// (readers fall back on the magic header), but they remain unprotected on disk
// until re-written. This sweep closes that gap, mirroring the automatic index-DB
// migration shipped in #56.
//
// It is restricted to the known blob-kind subdirectories of the storage root, so
// it can never touch the index DB, its WAL/SHM sidecars, config, or key files —
// even if `storage.path` is pointed at a shared directory. Each file is encrypted
// to a temp sibling and atomically renamed, so an interrupted sweep is safe and
// resumable; a completion marker lets later startups skip the rescan.

import { type Dirent, existsSync } from 'node:fs'
import { open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { decryptBlob, encryptBlob, hasBlobMagic, isEncryptedBlob } from './blob_crypto'

// The capture kinds makeBlobStore partitions blobs under (see blobs.ts /
// audio.ts:chunkKind). Anything outside these is left untouched.
const BLOB_KINDS = ['screenshot', 'audio_mic', 'audio_system']
const MARKER = '.blobs-migrated-v1'
const TMP_SUFFIX = '.enc.tmp'

export interface BlobMigrationResult {
  scanned: number
  encrypted: number
  skipped: number
  errors: number
}

// True once a full sweep has completed (every plaintext blob encrypted).
export function blobsMigrated(rootDir: string): boolean {
  return existsSync(join(rootDir, MARKER))
}

async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // directory absent (kind never captured) — nothing to do
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(full)
    else if (entry.isFile()) yield full
  }
}

async function encryptInPlace(path: string, key: Buffer): Promise<'encrypted' | 'skipped'> {
  // Sniff the first bytes so an already-encrypted (and possibly large) file is
  // skipped without being read in full.
  const header = Buffer.alloc(4)
  const fh = await open(path, 'r')
  try {
    await fh.read(header, 0, 4, 0)
  } finally {
    await fh.close()
  }
  if (hasBlobMagic(header)) return 'skipped'

  const plain = await readFile(path)
  if (isEncryptedBlob(plain)) return 'skipped' // defensive: short/racing writes
  const tmp = `${path}${TMP_SUFFIX}`
  await writeFile(tmp, encryptBlob(key, plain))
  await rename(tmp, path)
  return 'encrypted'
}

// Encrypts every plaintext blob under the storage root's kind subdirectories.
// Writes the completion marker only on a clean pass (no errors), so a partial or
// failed sweep retries on the next startup.
export async function migrateBlobsToEncrypted(
  rootDir: string,
  key: Buffer,
): Promise<BlobMigrationResult> {
  const result: BlobMigrationResult = { scanned: 0, encrypted: 0, skipped: 0, errors: 0 }
  for (const kind of BLOB_KINDS) {
    for await (const path of walkFiles(join(rootDir, kind))) {
      if (path.endsWith(TMP_SUFFIX)) continue // leftover from an interrupted run
      result.scanned++
      try {
        result[await encryptInPlace(path, key)]++
      } catch {
        result.errors++
      }
    }
  }
  if (result.errors === 0) {
    await writeFile(join(rootDir, MARKER), `${new Date().toISOString()}\n`)
  }
  return result
}

// Runs the sweep once, guarded by the completion marker. Safe to call on every
// startup; resolves to undefined when the marker is already present.
export async function migrateBlobsIfNeeded(
  rootDir: string,
  key: Buffer,
): Promise<BlobMigrationResult | undefined> {
  if (blobsMigrated(rootDir)) return undefined
  return migrateBlobsToEncrypted(rootDir, key)
}

async function decryptInPlace(path: string, key: Buffer): Promise<'decrypted' | 'skipped'> {
  const header = Buffer.alloc(4)
  const fh = await open(path, 'r')
  try {
    await fh.read(header, 0, 4, 0)
  } finally {
    await fh.close()
  }
  if (!hasBlobMagic(header)) return 'skipped' // already plaintext

  const enc = await readFile(path)
  if (!isEncryptedBlob(enc)) return 'skipped'
  const tmp = `${path}${TMP_SUFFIX}`
  await writeFile(tmp, decryptBlob(key, enc))
  await rename(tmp, path)
  return 'decrypted'
}

export interface BlobDecryptResult {
  scanned: number
  decrypted: number
  skipped: number
  errors: number
}

// Reverse of migrateBlobsToEncrypted: turns every encrypted blob back to
// plaintext in place (decrypt -> atomic rename). Removes the completion marker,
// since the tree is no longer fully encrypted. Used by `hpm decrypt --blobs`.
export async function decryptBlobsToPlaintext(
  rootDir: string,
  key: Buffer,
): Promise<BlobDecryptResult> {
  const result: BlobDecryptResult = { scanned: 0, decrypted: 0, skipped: 0, errors: 0 }
  for (const kind of BLOB_KINDS) {
    for await (const path of walkFiles(join(rootDir, kind))) {
      if (path.endsWith(TMP_SUFFIX)) continue
      result.scanned++
      try {
        result[await decryptInPlace(path, key)]++
      } catch {
        result.errors++
      }
    }
  }
  await rm(join(rootDir, MARKER), { force: true })
  return result
}
