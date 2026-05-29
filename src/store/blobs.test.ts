import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { makeBlobStore } from './blobs'

const dirs: string[] = []

function freshRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-blobs-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('path() partitions by UTC date at a timezone frontier', () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.parse('2024-12-31T23:30:00-01:00') // 2025-01-01T00:30:00Z

  expect(store.path('screenshot', 'frontier', 'png', at)).toBe(
    join(root, 'screenshot', '2025', '01', '01', 'frontier.png'),
  )
})

test('path() zero-pads month and day without creating directories', () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 2, 4, 12)
  const path = store.path('audio_mic', 'chunk-1', 'wav', at)

  expect(path).toBe(join(root, 'audio_mic', '2025', '03', '04', 'chunk-1.wav'))
  expect(isAbsolute(path)).toBe(true)
  expect(existsSync(join(root, 'audio_mic'))).toBe(false)
})

test('write() writes bytes to the expected partition and returns the absolute path', async () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 6, 9)
  const expected = join(root, 'screenshot', '2025', '07', '09', 'img-1.jpg')

  const written = await store.write('screenshot', 'img-1', 'jpg', Buffer.from('image-bytes'), at)

  expect(written).toBe(expected)
  expect(isAbsolute(written)).toBe(true)
  expect(readFileSync(expected, 'utf8')).toBe('image-bytes')
})

test('write() can reuse an existing partition directory', async () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 0, 2)

  const first = await store.write('audio_system', 'a', 'wav', Buffer.from('first'), at)
  const second = await store.write('audio_system', 'b', 'wav', Buffer.from('second'), at)

  expect(readFileSync(first, 'utf8')).toBe('first')
  expect(readFileSync(second, 'utf8')).toBe('second')
  expect(second).toBe(join(root, 'audio_system', '2025', '01', '02', 'b.wav'))
})

test('path() matches write() layout for the same inputs', async () => {
  const root = freshRoot()
  const store = makeBlobStore(root)
  const at = Date.UTC(2025, 10, 11)
  const expected = store.path('screenshot', 'same-layout', 'png', at)

  const written = await store.write('screenshot', 'same-layout', 'png', Buffer.from('x'), at)

  expect(written).toBe(expected)
})

test('write() propagates mkdir errors other than EEXIST', async () => {
  const root = freshRoot()
  const blocker = join(root, 'not-a-directory')
  writeFileSync(blocker, 'x')
  const store = makeBlobStore(blocker)

  await expect(store.write('screenshot', 'blocked', 'png', Buffer.from('x'))).rejects.toThrow()
})
