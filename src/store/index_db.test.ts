import { Database as BunDatabase } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import { HyprmnesiaReadStore } from '../mcp/read_store'
import { openChunkStore } from './db'
import { ensureDecrypted, isIndexDbEncrypted } from './index_db'
import { sqliteCipherAvailable } from './sqlcipher/ffi'

// These exercise the encrypted (FFI sqlite3mc) backend, so they need the native
// library. It is built in CI before `bun test`; locally run
// `bun run scripts/build-sqlcipher.ts` first.
const dirs: string[] = []

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-enc-'))
  dirs.push(dir)
  return dir
}

function insertChunk(store: ReturnType<typeof openChunkStore>, text: string): string {
  const id = randomUUIDv7()
  store.insert({
    id,
    kind: 'screenshot',
    at: Date.now(),
    blob: '/tmp/x.png',
    bytes: 10,
    text,
    capture_ms: 1,
  })
  return id
}

// Reading an encrypted file with plain bun:sqlite must fail.
function plaintextReadFails(dbPath: string): boolean {
  try {
    const db = new BunDatabase(dbPath, { readonly: true })
    db.query('SELECT count(*) FROM chunks').get()
    db.close()
    return false
  } catch {
    return true
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        const until = Date.now() + 100
        while (Date.now() < until) {}
      }
    }
  }
})

describe.skipIf(!sqliteCipherAvailable())('encrypted index DB', () => {
  test('round-trips through an encrypted DB and search still works', () => {
    const dbPath = join(freshDir(), 'index.db')
    const key = randomBytes(32)

    const store = openChunkStore(dbPath, { key })
    const id = insertChunk(store, 'encrypted invoice dashboard')
    store.close()

    expect(plaintextReadFails(dbPath)).toBe(true)

    const read = new HyprmnesiaReadStore(dbPath, { key })
    const results = read.search('invoice', { mode: 'lexical' })
    read.close()
    expect(results.map((r) => r.id)).toContain(id)
  })

  test('migrates a legacy plaintext DB to encrypted on first keyed open', () => {
    const dbPath = join(freshDir(), 'index.db')
    const key = randomBytes(32)

    // Legacy plaintext DB (no key).
    const plain = openChunkStore(dbPath)
    const id = insertChunk(plain, 'legacy plaintext note')
    plain.close()
    expect(plaintextReadFails(dbPath)).toBe(false)

    // Opening with a key migrates in place.
    const migrated = openChunkStore(dbPath, { key })
    migrated.close()
    expect(plaintextReadFails(dbPath)).toBe(true)
    expect(existsSync(`${dbPath}.enc.tmp`)).toBe(false)

    const read = new HyprmnesiaReadStore(dbPath, { key })
    const results = read.search('legacy', { mode: 'lexical' })
    read.close()
    expect(results.map((r) => r.id)).toContain(id)
  })

  test('reader falls back to plaintext when a key is supplied for an unencrypted DB', () => {
    const dbPath = join(freshDir(), 'index.db')
    const plain = openChunkStore(dbPath)
    const id = insertChunk(plain, 'unencrypted searchable text')
    plain.close()

    // Key supplied, but the DB is plaintext: openReadIndexDb falls back.
    const read = new HyprmnesiaReadStore(dbPath, { key: randomBytes(32) })
    const results = read.search('searchable', { mode: 'lexical' })
    read.close()
    expect(results.map((r) => r.id)).toContain(id)
  })

  test('a wrong key cannot read an encrypted DB', () => {
    const dbPath = join(freshDir(), 'index.db')
    const store = openChunkStore(dbPath, { key: randomBytes(32) })
    insertChunk(store, 'secret')
    store.close()

    expect(() => new HyprmnesiaReadStore(dbPath, { key: randomBytes(32) })).toThrow()
  })

  test('ensureDecrypted turns an encrypted DB back to plaintext and stays searchable', () => {
    const dbPath = join(freshDir(), 'index.db')
    const key = randomBytes(32)
    const store = openChunkStore(dbPath, { key })
    const id = insertChunk(store, 'reversible secret note')
    store.close()
    expect(isIndexDbEncrypted(dbPath, key)).toBe(true)

    ensureDecrypted(dbPath, key)
    expect(isIndexDbEncrypted(dbPath, key)).toBe(false)
    expect(plaintextReadFails(dbPath)).toBe(false)
    expect(existsSync(`${dbPath}.dec.tmp`)).toBe(false)

    const read = new HyprmnesiaReadStore(dbPath)
    const results = read.search('reversible', { mode: 'lexical' })
    read.close()
    expect(results.map((r) => r.id)).toContain(id)
  })

  test('ensureDecrypted is a no-op on an already-plaintext DB', () => {
    const dbPath = join(freshDir(), 'index.db')
    const plain = openChunkStore(dbPath)
    insertChunk(plain, 'plain note')
    plain.close()

    ensureDecrypted(dbPath, randomBytes(32)) // must not throw or corrupt
    expect(plaintextReadFails(dbPath)).toBe(false)
  })
})
