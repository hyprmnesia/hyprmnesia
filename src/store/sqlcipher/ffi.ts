// Low-level bun:ffi bindings to a SQLite3MultipleCiphers shared library
// (sqlite3mc). This is the encryption-capable SQLite engine that replaces
// bun:sqlite project-wide: bun:sqlite cannot do SQLCipher, setCustomSQLite is
// macOS-only, and better-sqlite3 breaks under Bun's N-API + `bun build
// --compile`. FFI to a prebuilt shared lib (shipped in dist/native like
// vec0.dll) is the only path that works on Windows + Linux + macOS. See #12.
//
// Only the subset of the sqlite3 C API the codebase needs is bound here. The
// higher-level, bun:sqlite-compatible wrapper lives in ./database.ts.

import { dlopen, FFIType, suffix } from 'bun:ffi'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// SQLite result codes we branch on.
export const SQLITE_OK = 0
export const SQLITE_ROW = 100
export const SQLITE_DONE = 101
export const SQLITE_NOTADB = 26

// Column types (sqlite3_column_type).
export const SQLITE_INTEGER = 1
export const SQLITE_FLOAT = 2
export const SQLITE_TEXT = 3
export const SQLITE_BLOB = 4
export const SQLITE_NULL = 5

// Open flags (sqlite3_open_v2).
export const SQLITE_OPEN_READONLY = 0x1
export const SQLITE_OPEN_READWRITE = 0x2
export const SQLITE_OPEN_CREATE = 0x4

const { ptr, i32, i64, f64, cstring } = FFIType

const SYMBOLS = {
  sqlite3_open_v2: { args: [ptr, ptr, i32, ptr], returns: i32 },
  sqlite3_close_v2: { args: [ptr], returns: i32 },
  sqlite3_exec: { args: [ptr, ptr, ptr, ptr, ptr], returns: i32 },
  sqlite3_errmsg: { args: [ptr], returns: cstring },
  sqlite3_errstr: { args: [i32], returns: cstring },
  sqlite3_extended_errcode: { args: [ptr], returns: i32 },
  sqlite3_prepare_v2: { args: [ptr, ptr, i32, ptr, ptr], returns: i32 },
  sqlite3_finalize: { args: [ptr], returns: i32 },
  sqlite3_reset: { args: [ptr], returns: i32 },
  sqlite3_step: { args: [ptr], returns: i32 },
  sqlite3_bind_parameter_count: { args: [ptr], returns: i32 },
  sqlite3_bind_parameter_name: { args: [ptr, i32], returns: cstring },
  sqlite3_bind_text: { args: [ptr, i32, ptr, i32, ptr], returns: i32 },
  sqlite3_bind_int64: { args: [ptr, i32, i64], returns: i32 },
  sqlite3_bind_double: { args: [ptr, i32, f64], returns: i32 },
  sqlite3_bind_blob: { args: [ptr, i32, ptr, i32, ptr], returns: i32 },
  sqlite3_bind_null: { args: [ptr, i32], returns: i32 },
  sqlite3_column_count: { args: [ptr], returns: i32 },
  sqlite3_column_name: { args: [ptr, i32], returns: cstring },
  sqlite3_column_type: { args: [ptr, i32], returns: i32 },
  sqlite3_column_int64: { args: [ptr, i32], returns: i64 },
  sqlite3_column_double: { args: [ptr, i32], returns: f64 },
  sqlite3_column_text: { args: [ptr, i32], returns: ptr },
  sqlite3_column_blob: { args: [ptr, i32], returns: ptr },
  sqlite3_column_bytes: { args: [ptr, i32], returns: i32 },
  sqlite3_enable_load_extension: { args: [ptr, i32], returns: i32 },
  sqlite3_load_extension: { args: [ptr, ptr, ptr, ptr], returns: i32 },
} as const

export type SqliteLib = ReturnType<typeof dlopen<typeof SYMBOLS>>['symbols']

function libName(): string {
  // `suffix` is the platform's native shared-library extension (dll/dylib/so).
  if (process.platform === 'win32') return 'sqlite3mc.dll'
  return `libsqlite3mc.${suffix}`
}

// Mirrors findVecExtension in ../vec.ts: look next to the compiled executable
// first (dist/native), then common dev locations.
function findLib(): string | undefined {
  const name = libName()
  const candidates = [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'target', 'release', name),
  ]
  return candidates.find((p) => existsSync(p))
}

let cached: SqliteLib | undefined

// Loads sqlite3mc once. Throws a clear, actionable error if the library is
// missing — the engine is mandatory (it backs every DB connection), so we fail
// closed rather than silently degrading.
export function sqlite(): SqliteLib {
  if (cached) return cached
  const lib = findLib()
  if (!lib) {
    throw new Error(
      `SQLite engine (${libName()}) not found in dist/native or target/release. ` +
        'Run `bun run scripts/build-sqlcipher.ts` (or `bun run build`) to fetch/build it.',
    )
  }
  cached = dlopen(lib, SYMBOLS).symbols
  return cached
}

// True when the sqlite3mc library can be located and loaded. Used by tests to
// skip the encrypted path where the native lib has not been built yet.
export function sqliteCipherAvailable(): boolean {
  try {
    sqlite()
    return true
  } catch {
    return false
  }
}

// NUL-terminated UTF-8 buffer for passing JS strings as `const char *`.
export function cstr(s: string): Buffer {
  return Buffer.from(`${s}\0`, 'utf8')
}
