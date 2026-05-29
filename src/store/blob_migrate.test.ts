import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encryptBlob, isEncryptedBlob, readBlobFile } from './blob_crypto'
import { blobsMigrated, migrateBlobsIfNeeded, migrateBlobsToEncrypted } from './blob_migrate'

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hpm-blobmig-'))
}

function writeBlob(rootDir: string, kind: string, name: string, data: Buffer): string {
  const dir = join(rootDir, kind, '2025', '01', '01')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, data)
  return p
}

test('encrypts plaintext blobs, round-trips, and writes a completion marker', async () => {
  const dir = freshRoot()
  try {
    const key = randomBytes(32)
    const png = randomBytes(1234)
    const wav = randomBytes(5678)
    const pPng = writeBlob(dir, 'screenshot', 'a.png', png)
    const pWav = writeBlob(dir, 'audio_mic', 'b.wav', wav)

    const res = await migrateBlobsToEncrypted(dir, key)
    expect(res.encrypted).toBe(2)
    expect(res.errors).toBe(0)
    expect(isEncryptedBlob(readFileSync(pPng))).toBe(true)
    expect(isEncryptedBlob(readFileSync(pWav))).toBe(true)
    expect(readBlobFile(pPng, key).equals(png)).toBe(true)
    expect(readBlobFile(pWav, key).equals(wav)).toBe(true)
    expect(blobsMigrated(dir)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('is idempotent: marker short-circuits, a forced pass skips encrypted files', async () => {
  const dir = freshRoot()
  try {
    const key = randomBytes(32)
    const data = randomBytes(2048)
    const p = writeBlob(dir, 'screenshot', 'a.png', data)
    await migrateBlobsToEncrypted(dir, key)
    const afterFirst = readFileSync(p)

    expect(await migrateBlobsIfNeeded(dir, key)).toBeUndefined() // marker present

    const res = await migrateBlobsToEncrypted(dir, key)
    expect(res.encrypted).toBe(0)
    expect(res.skipped).toBe(1)
    expect(readFileSync(p).equals(afterFirst)).toBe(true) // not double-encrypted
    expect(readBlobFile(p, key).equals(data)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('never touches files outside the blob-kind subdirectories', async () => {
  const dir = freshRoot()
  try {
    const key = randomBytes(32)
    // The encrypted index DB can sit alongside blobs if storage.path is shared.
    // It is not an HPMB blob and must be left byte-for-byte intact.
    const fakeDb = join(dir, 'index.db')
    const dbBytes = randomBytes(4096)
    writeFileSync(fakeDb, dbBytes)
    const otherDir = join(dir, 'engines')
    mkdirSync(otherDir, { recursive: true })
    const otherFile = join(otherDir, 'model.bin')
    const otherBytes = randomBytes(256)
    writeFileSync(otherFile, otherBytes)

    writeBlob(dir, 'screenshot', 'a.png', randomBytes(100))
    const res = await migrateBlobsToEncrypted(dir, key)
    expect(res.encrypted).toBe(1)
    expect(readFileSync(fakeDb).equals(dbBytes)).toBe(true)
    expect(readFileSync(otherFile).equals(otherBytes)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('leaves pre-encrypted blobs byte-identical in a mixed directory', async () => {
  const dir = freshRoot()
  try {
    const key = randomBytes(32)
    const plainBytes = randomBytes(300)
    const encBytes = randomBytes(300)
    const pPlain = writeBlob(dir, 'audio_system', 'plain.wav', plainBytes)
    const pEnc = writeBlob(dir, 'audio_system', 'enc.wav', encryptBlob(key, encBytes))
    const encOnDisk = readFileSync(pEnc)

    const res = await migrateBlobsToEncrypted(dir, key)
    expect(res.encrypted).toBe(1)
    expect(res.skipped).toBe(1)
    expect(readFileSync(pEnc).equals(encOnDisk)).toBe(true) // not re-wrapped
    expect(readBlobFile(pPlain, key).equals(plainBytes)).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
