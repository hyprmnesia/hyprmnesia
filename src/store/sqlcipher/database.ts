// A bun:sqlite-compatible Database/Statement wrapper backed by the
// SQLite3MultipleCiphers FFI bindings (./ffi.ts). It reproduces only the slice
// of the bun:sqlite API the codebase uses, so the four DB modules can switch
// `import { Database } from 'bun:sqlite'` to this shim with minimal churn.
//
// The single addition over bun:sqlite is the `key` open option: when present we
// select the SQLCipher cipher and apply the raw 256-bit key as the very first
// operation, before any other statement runs. See #12.

import { CString, type Pointer, toArrayBuffer } from 'bun:ffi'
import {
  cstr,
  SQLITE_BLOB,
  SQLITE_DONE,
  SQLITE_FLOAT,
  SQLITE_INTEGER,
  SQLITE_OK,
  SQLITE_OPEN_CREATE,
  SQLITE_OPEN_READONLY,
  SQLITE_OPEN_READWRITE,
  SQLITE_ROW,
  SQLITE_TEXT,
  sqlite,
} from './ffi'

export interface DatabaseOptions {
  create?: boolean
  readonly?: boolean
  // Raw 256-bit key. When set, the database is opened with the SQLCipher cipher.
  key?: Buffer | Uint8Array
}

export class SqliteError extends Error {
  constructor(
    message: string,
    // Primary SQLite result code (rc & 0xff); 26 = SQLITE_NOTADB.
    readonly code: number,
  ) {
    super(message)
    this.name = 'SqliteError'
  }
}

function isParamBag(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value) &&
    !(value instanceof ArrayBuffer)
  )
}

export class Statement<Row = Record<string, unknown>> {
  private finalized = false
  // Retains buffers bound with SQLITE_STATIC until the next reset/step cycle.
  private bound: Buffer[] = []

  constructor(
    private readonly db: Database,
    private readonly handle: Pointer,
    readonly sql: string,
  ) {}

  private get lib() {
    return sqlite()
  }

  private bindAll(args: unknown[]): void {
    this.lib.sqlite3_reset(this.handle)
    this.bound = []
    if (args.length === 1 && isParamBag(args[0])) {
      const bag = args[0]
      const count = this.lib.sqlite3_bind_parameter_count(this.handle)
      for (let i = 1; i <= count; i++) {
        const named = this.lib.sqlite3_bind_parameter_name(this.handle, i)
        const name = named?.toString()
        let value: unknown
        if (name && name in bag) value = bag[name]
        else if (name) value = bag[name.slice(1)] // strip leading $ / : / @
        this.bindOne(i, value)
      }
      return
    }
    for (let i = 0; i < args.length; i++) this.bindOne(i + 1, args[i])
  }

  private bindOne(index: number, value: unknown): void {
    const lib = this.lib
    if (value === null || value === undefined) {
      lib.sqlite3_bind_null(this.handle, index)
    } else if (typeof value === 'bigint') {
      lib.sqlite3_bind_int64(this.handle, index, value)
    } else if (typeof value === 'boolean') {
      lib.sqlite3_bind_int64(this.handle, index, value ? 1n : 0n)
    } else if (typeof value === 'number') {
      if (Number.isInteger(value)) lib.sqlite3_bind_int64(this.handle, index, BigInt(value))
      else lib.sqlite3_bind_double(this.handle, index, value)
    } else if (typeof value === 'string') {
      const buf = Buffer.from(value, 'utf8')
      this.bound.push(buf)
      lib.sqlite3_bind_text(this.handle, index, buf, buf.length, null)
    } else if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      const buf = Buffer.isBuffer(value) ? value : Buffer.from(value)
      this.bound.push(buf)
      lib.sqlite3_bind_blob(this.handle, index, buf, buf.length, null)
    } else {
      throw new TypeError(`cannot bind value of type ${typeof value}`)
    }
  }

  private readRow(): Row {
    const lib = this.lib
    const count = lib.sqlite3_column_count(this.handle)
    const row: Record<string, unknown> = {}
    for (let i = 0; i < count; i++) {
      const name = lib.sqlite3_column_name(this.handle, i)?.toString() ?? String(i)
      row[name] = this.readColumn(i)
    }
    return row as Row
  }

  private readColumn(i: number): unknown {
    const lib = this.lib
    switch (lib.sqlite3_column_type(this.handle, i)) {
      case SQLITE_INTEGER:
        return Number(lib.sqlite3_column_int64(this.handle, i))
      case SQLITE_FLOAT:
        return lib.sqlite3_column_double(this.handle, i)
      case SQLITE_TEXT: {
        const ptr = lib.sqlite3_column_text(this.handle, i)
        const n = lib.sqlite3_column_bytes(this.handle, i)
        if (!ptr || n === 0) return ''
        return new CString(ptr, 0, n).toString()
      }
      case SQLITE_BLOB: {
        const ptr = lib.sqlite3_column_blob(this.handle, i)
        const n = lib.sqlite3_column_bytes(this.handle, i)
        if (!ptr || n === 0) return Buffer.alloc(0)
        // Copy out of SQLite-owned memory (valid only until the next step/reset).
        const out = Buffer.alloc(n)
        Buffer.from(toArrayBuffer(ptr, 0, n)).copy(out)
        return out
      }
      default:
        return null
    }
  }

  private step(): number {
    const rc = this.lib.sqlite3_step(this.handle)
    if (rc !== SQLITE_ROW && rc !== SQLITE_DONE) this.db.fail(rc)
    return rc
  }

  run(...args: unknown[]): void {
    this.assertOpen()
    this.bindAll(args)
    while (this.step() === SQLITE_ROW) {}
    this.lib.sqlite3_reset(this.handle)
    this.bound = []
  }

  get(...args: unknown[]): Row | undefined {
    this.assertOpen()
    this.bindAll(args)
    const row = this.step() === SQLITE_ROW ? this.readRow() : undefined
    this.lib.sqlite3_reset(this.handle)
    this.bound = []
    return row
  }

  all(...args: unknown[]): Row[] {
    this.assertOpen()
    this.bindAll(args)
    const rows: Row[] = []
    while (this.step() === SQLITE_ROW) rows.push(this.readRow())
    this.lib.sqlite3_reset(this.handle)
    this.bound = []
    return rows
  }

  finalize(): void {
    if (this.finalized) return
    this.finalized = true
    this.bound = []
    this.lib.sqlite3_finalize(this.handle)
    this.db.untrack(this as Statement<unknown>)
  }

  private assertOpen(): void {
    if (this.finalized) throw new SqliteError('statement is finalized', SQLITE_OK)
  }
}

export class Database {
  private handle: Pointer
  private closed = false
  private readonly cache = new Map<string, Statement<unknown>>()
  private readonly statements = new Set<Statement<unknown>>()

  constructor(path: string, opts: DatabaseOptions = {}) {
    const lib = sqlite()
    const flags = opts.readonly
      ? SQLITE_OPEN_READONLY
      : SQLITE_OPEN_READWRITE | ((opts.create ?? true) ? SQLITE_OPEN_CREATE : 0)
    const ppDb = new BigUint64Array(1)
    const rc = lib.sqlite3_open_v2(cstr(path), ppDb, flags, null)
    this.handle = Number(ppDb[0]) as Pointer
    if (rc !== SQLITE_OK) {
      const msg = this.handle ? lib.sqlite3_errmsg(this.handle)?.toString() : undefined
      if (this.handle) lib.sqlite3_close_v2(this.handle)
      this.closed = true
      throw new SqliteError(
        msg ?? lib.sqlite3_errstr(rc)?.toString() ?? `open failed (${rc})`,
        rc & 0xff,
      )
    }
    if (opts.key) this.applyKey(opts.key)
  }

  // Selects the SQLCipher cipher and applies the raw key. Must run before any
  // other statement. A wrong/absent key does not fail here — it surfaces as
  // SQLITE_NOTADB on the caller's first real read (used for migration detection
  // and the read-side plaintext fallback).
  private applyKey(key: Buffer | Uint8Array): void {
    const hex = Buffer.from(key).toString('hex')
    this.exec("PRAGMA cipher = 'sqlcipher';")
    this.exec(`PRAGMA key = "x'${hex}'";`)
  }

  // Raw param-less execution (PRAGMA, DDL, BEGIN/COMMIT). Handles multi-statement
  // SQL like the schema blocks.
  private exec(sql: string): void {
    const rc = sqlite().sqlite3_exec(this.handle, cstr(sql), null, null, null)
    if (rc !== SQLITE_OK) this.fail(rc)
  }

  // Throws a SqliteError carrying the primary result code, using the live error
  // message when available. Public so Statement can delegate to it.
  fail(rc: number): never {
    const msg = sqlite().sqlite3_errmsg(this.handle)?.toString()
    throw new SqliteError(
      msg ?? sqlite().sqlite3_errstr(rc)?.toString() ?? `error ${rc}`,
      rc & 0xff,
    )
  }

  run(sql: string): void {
    this.exec(sql)
  }

  private prepareHandle(sql: string): Pointer {
    const lib = sqlite()
    const ppStmt = new BigUint64Array(1)
    const rc = lib.sqlite3_prepare_v2(this.handle, cstr(sql), -1, ppStmt, null)
    if (rc !== SQLITE_OK) this.fail(rc)
    return Number(ppStmt[0]) as Pointer
  }

  // Cached prepared statement (bun:sqlite `query` semantics): reused across
  // calls and finalized on close.
  query<Row = Record<string, unknown>>(sql: string): Statement<Row> {
    const existing = this.cache.get(sql)
    if (existing) return existing as Statement<Row>
    const stmt = new Statement<Row>(this, this.prepareHandle(sql), sql)
    this.cache.set(sql, stmt as Statement<unknown>)
    this.statements.add(stmt as Statement<unknown>)
    return stmt
  }

  // Fresh prepared statement (bun:sqlite `prepare` semantics): the caller owns
  // its lifecycle and is expected to call finalize().
  prepare<Row = Record<string, unknown>>(sql: string): Statement<Row> {
    const stmt = new Statement<Row>(this, this.prepareHandle(sql), sql)
    this.statements.add(stmt as Statement<unknown>)
    return stmt
  }

  // Returns a callable that runs `fn` inside BEGIN/COMMIT, rolling back on throw.
  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const run = (...args: never[]): unknown => {
      this.exec('BEGIN')
      try {
        const result = fn(...args)
        this.exec('COMMIT')
        return result
      } catch (err) {
        try {
          this.exec('ROLLBACK')
        } catch {}
        throw err
      }
    }
    return run as F
  }

  loadExtension(path: string): void {
    const lib = sqlite()
    lib.sqlite3_enable_load_extension(this.handle, 1)
    try {
      const rc = lib.sqlite3_load_extension(this.handle, cstr(path), null, null)
      if (rc !== SQLITE_OK) this.fail(rc)
    } finally {
      lib.sqlite3_enable_load_extension(this.handle, 0)
    }
  }

  untrack(stmt: Statement<unknown>): void {
    this.statements.delete(stmt)
    if (this.cache.get(stmt.sql) === stmt) this.cache.delete(stmt.sql)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const stmt of [...this.statements]) stmt.finalize()
    sqlite().sqlite3_close_v2(this.handle)
  }
}
