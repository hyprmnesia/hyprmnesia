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
