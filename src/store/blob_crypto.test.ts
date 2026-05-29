import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decryptBlob,
  deriveBlobKey,
  encryptBlob,
  isEncryptedBlob,
  readBlobFile,
} from './blob_crypto'

const key = () => randomBytes(32)

test('encrypt -> decrypt round-trips arbitrary bytes', () => {
  const k = key()
  const plain = randomBytes(50_000)
  const enc = encryptBlob(k, plain)
  expect(enc.equals(plain)).toBe(false)
  expect(isEncryptedBlob(enc)).toBe(true)
  expect(decryptBlob(k, enc).equals(plain)).toBe(true)
})

test('round-trips empty plaintext', () => {
  const k = key()
  const enc = encryptBlob(k, Buffer.alloc(0))
  expect(decryptBlob(k, enc).length).toBe(0)
})

test('isEncryptedBlob is false for real image/audio signatures', () => {
  expect(isEncryptedBlob(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe(false) // PNG
  expect(isEncryptedBlob(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(false) // JPEG
  expect(isEncryptedBlob(Buffer.from('RIFF....WAVE'))).toBe(false) // WAV
  expect(isEncryptedBlob(Buffer.from('HPMB'))).toBe(false) // magic but too short
})

test('decrypt with the wrong key throws (GCM auth fails)', () => {
  const enc = encryptBlob(key(), randomBytes(1024))
  expect(() => decryptBlob(key(), enc)).toThrow()
})

test('decrypt of a tampered ciphertext throws', () => {
  const k = key()
  const enc = encryptBlob(k, randomBytes(1024))
  const last = enc.length - 1
  enc[last] = (enc[last] ?? 0) ^ 0xff // flip a byte in the auth tag
  expect(() => decryptBlob(k, enc)).toThrow()
})

test('deriveBlobKey is deterministic and distinct from the master', () => {
  const master = key()
  const a = deriveBlobKey(master)
  const b = deriveBlobKey(master)
  expect(a.length).toBe(32)
  expect(a.equals(b)).toBe(true)
  expect(a.equals(master)).toBe(false)
  expect(deriveBlobKey(key()).equals(a)).toBe(false)
})

test('readBlobFile returns plaintext as-is and decrypts encrypted files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-blobcrypto-'))
  try {
    const k = key()
    const plain = Buffer.from('legacy plaintext screenshot bytes')

    const plainPath = join(dir, 'legacy.png')
    writeFileSync(plainPath, plain)
    expect(readBlobFile(plainPath, k).equals(plain)).toBe(true)
    expect(readBlobFile(plainPath).equals(plain)).toBe(true) // no key needed

    const encPath = join(dir, 'enc.png')
    writeFileSync(encPath, encryptBlob(k, plain))
    expect(readBlobFile(encPath, k).equals(plain)).toBe(true)
    expect(() => readBlobFile(encPath)).toThrow() // encrypted but no key
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
