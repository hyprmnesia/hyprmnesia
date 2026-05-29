// Factory that picks the SQLite backend for the index DB:
//   - no key  -> bun:sqlite (the battle-tested engine; used by tests and when
//                encryption is disabled)
//   - key set -> the bun:ffi SQLite3MultipleCiphers shim (encrypted at rest)
//
// Both backends expose the same IndexDb surface, so the store modules (db.ts,
// read_store, replay/store) are backend-agnostic. See #12.

import { Database as BunDatabase } from 'bun:sqlite'
import { copyFileSync, existsSync, renameSync, rmSync } from 'node:fs'
import { Database as CipherDatabase, SqliteError } from './sqlcipher/database'
import { SQLITE_NOTADB } from './sqlcipher/ffi'

export interface IndexStatement<Row> {
  get(...params: unknown[]): Row | undefined
  all(...params: unknown[]): Row[]
  run(...params: unknown[]): void
  finalize(): void
}

// The slice of the bun:sqlite Database API the codebase relies on. Both backends
// satisfy it structurally.
export interface IndexDb {
  run(sql: string): void
  query<Row = Record<string, unknown>, _Params = unknown>(sql: string): IndexStatement<Row>
  prepare<Row = Record<string, unknown>, _Params = unknown>(sql: string): IndexStatement<Row>
  transaction<F extends (...args: never[]) => unknown>(fn: F): F
  loadExtension(path: string): void
  close(): void
}

export interface OpenIndexDbOptions {
  readonly?: boolean
  create?: boolean
  // Raw 256-bit key. When present the encrypted (FFI) backend is used.
  key?: Buffer
}

export function openIndexDb(path: string, opts: OpenIndexDbOptions = {}): IndexDb {
  if (opts.key) {
    return new CipherDatabase(path, {
      readonly: opts.readonly,
      create: opts.create,
      key: opts.key,
    }) as unknown as IndexDb
  }
  return new BunDatabase(path, {
    readonly: opts.readonly,
    create: opts.create ?? !opts.readonly,
  }) as unknown as IndexDb
}

// Opens the index DB read-only. With a key it opens encrypted, transparently
// falling back to a plaintext open if the file turns out to be unencrypted (a
// legacy DB the writer has not migrated yet). The caller still validates the
// schema version afterwards.
export function openReadIndexDb(path: string, key?: Buffer): IndexDb {
  if (!key) return openIndexDb(path, { readonly: true })
  const db = openIndexDb(path, { readonly: true, key })
  try {
    db.query('SELECT count(*) FROM sqlite_master').get()
    return db
  } catch (err) {
    db.close()
    if (err instanceof SqliteError && err.code === SQLITE_NOTADB) {
      return openIndexDb(path, { readonly: true })
    }
    throw err
  }
}

// Returns true if the file is already encrypted with `key` (readable), false if
// it is plaintext, and throws if it is encrypted with a different key.
function probe(path: string, key: Buffer): boolean {
  try {
    const db = openIndexDb(path, { readonly: true, key })
    try {
      db.query('SELECT count(*) FROM sqlite_master').get()
      return true
    } finally {
      db.close()
    }
  } catch (err) {
    if (!(err instanceof SqliteError) || err.code !== SQLITE_NOTADB) throw err
  }
  // Keyed open failed with NOTADB: confirm it is genuinely plaintext.
  try {
    const db = openIndexDb(path, { readonly: true })
    try {
      db.query('SELECT count(*) FROM sqlite_master').get()
      return false
    } finally {
      db.close()
    }
  } catch (err) {
    throw new Error(
      `index DB at ${path} is encrypted with a different key (cannot read with the current ` +
        `index key). Refusing to touch it. Restore the original key or move the file aside. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    )
  }
}

// Windows can keep a brief lock on a just-closed SQLite file (more so for an
// encrypted one), so deleting it right after close transiently fails with EBUSY.
// Retry with a short spin before surfacing the error.
function rmFileWithRetry(target: string): void {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(target, { force: true })
      return
    } catch {
      const until = Date.now() + 25
      while (Date.now() < until) {}
    }
  }
  rmSync(target, { force: true }) // final attempt; surface the error if still locked
}

// Whether the index DB at `path` is encrypted with `key`. False when the file is
// absent or plaintext; throws when it is encrypted with a different key. Lets the
// writer decide how to open an existing DB when database encryption is off.
export function isIndexDbEncrypted(path: string, key: Buffer): boolean {
  if (!existsSync(path)) return false
  return probe(path, key)
}

// Inverse of ensureEncrypted: turns an encrypted index DB back into plaintext in
// place (copy -> PRAGMA rekey to empty -> atomic replace). No-op when the file is
// absent or already plaintext. Used by `hpm decrypt --db`.
export function ensureDecrypted(path: string, key: Buffer): void {
  if (!existsSync(path)) return
  if (!probe(path, key)) return // already plaintext

  // Checkpoint so all committed data lives in the main file before copying.
  {
    const src = new CipherDatabase(path, { key })
    try {
      src.run('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      src.close()
    }
  }

  const tmp = `${path}.dec.tmp`
  rmSync(tmp, { force: true })
  copyFileSync(path, tmp)

  const dec = new CipherDatabase(tmp, { key })
  try {
    dec.run("PRAGMA cipher = 'sqlcipher';")
    // An empty key removes encryption entirely (sqlite3mc), leaving a plaintext DB.
    dec.run('PRAGMA rekey = "";')
    dec.run('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (err) {
    dec.close()
    rmSync(tmp, { force: true })
    throw err
  }
  dec.close()

  // Replace the encrypted original; drop its WAL sidecars.
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  rmFileWithRetry(path)
  renameSync(tmp, path)
}

// Ensures the index DB at `path` is encrypted with `key`, migrating a legacy
// plaintext database in place (copy -> rekey -> atomic replace). No-op when the
// file is absent (it will be created encrypted) or already encrypted.
export function ensureEncrypted(path: string, key: Buffer): void {
  if (!existsSync(path)) return
  if (probe(path, key)) return

  // Checkpoint so all committed data lives in the main file before copying.
  {
    const src = new CipherDatabase(path, {})
    try {
      src.run('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally {
      src.close()
    }
  }

  const tmp = `${path}.enc.tmp`
  rmSync(tmp, { force: true })
  copyFileSync(path, tmp)

  const hex = key.toString('hex')
  const enc = new CipherDatabase(tmp, {})
  try {
    enc.run("PRAGMA cipher = 'sqlcipher';")
    enc.run(`PRAGMA rekey = "x'${hex}'";`)
  } catch (err) {
    enc.close()
    rmSync(tmp, { force: true })
    throw err
  }
  enc.close()

  // Replace the plaintext original; drop its WAL sidecars.
  rmSync(`${path}-wal`, { force: true })
  rmSync(`${path}-shm`, { force: true })
  rmFileWithRetry(path)
  renameSync(tmp, path)
}
