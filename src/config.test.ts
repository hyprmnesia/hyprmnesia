import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config'

const dirs: string[] = []

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-cfg-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, contents)
  return path
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('embeddings default to the local engine with the locked model/dim', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.processing.embeddings.engine).toBe('local')
  expect(cfg.processing.embeddings.options?.model).toBe('multilingual-e5-small')
  expect(cfg.processing.embeddings.options?.dim).toBe(384)
})

test('unknown embedding engine falls back to local and locks model/dim', () => {
  const cfg = loadConfig(
    tmpConfig('{"processing":{"embeddings":{"engine":"bogus","options":{"model":"x","dim":99}}}}'),
  )
  expect(cfg.processing.embeddings.engine).toBe('local')
  expect(cfg.processing.embeddings.options?.model).toBe('multilingual-e5-small')
  expect(cfg.processing.embeddings.options?.dim).toBe(384)
})

test('embeddings engine can be disabled with noop', () => {
  const cfg = loadConfig(tmpConfig('{"processing":{"embeddings":{"engine":"noop"}}}'))
  expect(cfg.processing.embeddings.engine).toBe('noop')
})

test('MCP auth is enabled by default', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.mcp.auth.enabled).toBe(true)
})

test('MCP auth can be explicitly disabled', () => {
  const cfg = loadConfig(tmpConfig('{"mcp":{"auth":{"enabled":false}}}'))
  expect(cfg.mcp.auth.enabled).toBe(false)
})

test('malformed MCP auth config falls back to enabled', () => {
  const cfg = loadConfig(tmpConfig('{"mcp":{"auth":{"enabled":"nope"}}}'))
  expect(cfg.mcp.auth.enabled).toBe(true)
})

test('encryption defaults to on for both database and blobs', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.storage.encryption.database).toBe(true)
  expect(cfg.storage.encryption.blobs).toBe(true)
})

test('legacy encryption.enabled migrates to both database and blobs', () => {
  const cfg = loadConfig(tmpConfig('{"storage":{"encryption":{"enabled":false}}}'))
  expect(cfg.storage.encryption.database).toBe(false)
  expect(cfg.storage.encryption.blobs).toBe(false)
  expect((cfg.storage.encryption as Record<string, unknown>).enabled).toBeUndefined()
})

test('explicit split flags override the legacy enabled flag', () => {
  const cfg = loadConfig(
    tmpConfig('{"storage":{"encryption":{"enabled":true,"database":true,"blobs":false}}}'),
  )
  expect(cfg.storage.encryption.database).toBe(true)
  expect(cfg.storage.encryption.blobs).toBe(false)
})

test('malformed encryption flags fall back to defaults (on)', () => {
  const cfg = loadConfig(tmpConfig('{"storage":{"encryption":{"database":"nope"}}}'))
  expect(cfg.storage.encryption.database).toBe(true)
  expect(cfg.storage.encryption.blobs).toBe(true)
})

test('lossy blob formats default to webp screenshots and webm audio', () => {
  const cfg = loadConfig(tmpConfig('{}'))
  expect(cfg.capture.screen.format).toBe('webp')
  expect(cfg.capture.audio.format).toBe('webm')
  expect(cfg.capture.audio.bitrate_kbps).toBe(24)
})

test('invalid blob formats fall back to lossy defaults and clamp bitrate', () => {
  const cfg = loadConfig(
    tmpConfig(
      '{"capture":{"screen":{"format":"gif"},"audio":{"format":"mp3","bitrate_kbps":999}}}',
    ),
  )
  expect(cfg.capture.screen.format).toBe('webp')
  expect(cfg.capture.audio.format).toBe('webm')
  expect(cfg.capture.audio.bitrate_kbps).toBe(256)
})
