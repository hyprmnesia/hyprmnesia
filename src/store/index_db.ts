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
  rmSync(path, { force: true })
  renameSync(tmp, path)
}
