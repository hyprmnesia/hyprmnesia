import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isEncryptedBlob, readBlobFile } from './blob_crypto'
import { makeBlobStore } from './blobs'

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hpm-blobs-'))
}

test('writes plaintext when no key is given', async () => {
  const root = freshRoot()
  try {
    const store = makeBlobStore(root)
    const data = Buffer.from('hello plaintext')
    const path = await store.write('screenshot', 'id1', 'png', data, Date.now())
    const onDisk = readFileSync(path)
    expect(isEncryptedBlob(onDisk)).toBe(false)
    expect(onDisk.equals(data)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('encrypts on disk but round-trips via readBlobFile when keyed', async () => {
  const root = freshRoot()
  try {
    const key = randomBytes(32)
    const store = makeBlobStore(root, { key })
    const data = randomBytes(20_000)
    const path = await store.write('audio_mic', 'id2', 'wav', data, Date.now())
    const onDisk = readFileSync(path)
    expect(isEncryptedBlob(onDisk)).toBe(true)
    expect(onDisk.equals(data)).toBe(false)
    expect(readBlobFile(path, key).equals(data)).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
