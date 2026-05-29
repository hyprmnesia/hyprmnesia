// Throwaway validation harness for the bun:ffi sqlite3mc shim. Exercises the
// exact features the codebase relies on against the real native library:
// encrypted open, FTS5, params (positional + named), transactions, blobs,
// wrong/missing key -> NOTADB, vec0 loadExtension, and plaintext->encrypted
// migration via copy + PRAGMA rekey. Run: `bun run scripts/smoke-sqlcipher.ts`.

import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database, SqliteError } from '../src/store/sqlcipher/database'
import { SQLITE_NOTADB } from '../src/store/sqlcipher/ffi'

const dir = mkdtempSync(join(tmpdir(), 'hpm-smoke-'))
const dbPath = join(dir, 'index.db')
const KEY = Buffer.from('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 'hex')
const WRONG = Buffer.from('ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex')

let failures = 0
function ok(label: string, cond: boolean) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`)
  if (!cond) failures++
}

try {
  // 1. Create encrypted, schema with FTS5, insert via named + positional params.
  {
    const db = new Database(dbPath, { create: true, key: KEY })
    db.run('PRAGMA journal_mode = WAL')
    db.run(`CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER, f REAL, b BLOB);
            CREATE VIRTUAL TABLE fts USING fts5(text);`)
    const ins = db.prepare('INSERT INTO t (id, n, f, b) VALUES ($id, $n, $f, $b)')
    db.transaction(() => {
      ins.run({ $id: 'a', $n: 42, $f: 3.5, $b: Buffer.from([1, 2, 3, 4]) })
      ins.run({ $id: 'b', $n: 7, $f: 1.25, $b: null })
    })()
    ins.finalize()
    db.run("INSERT INTO fts (text) VALUES ('the quick brown fox')")

    const row = db
      .query<{ id: string; n: number; f: number; b: Buffer | null }>(
        'SELECT id, n, f, b FROM t WHERE id = ?',
      )
      .get('a')
    ok('named insert + positional select', row?.id === 'a' && row?.n === 42 && row?.f === 3.5)
    ok(
      'blob round-trips',
      Buffer.isBuffer(row?.b) && (row?.b as Buffer).length === 4 && (row?.b as Buffer)[2] === 3,
    )

    const all = db.query<{ id: string }>('SELECT id FROM t ORDER BY n').all()
    ok('all() ordering', all.length === 2 && all[0]?.id === 'b' && all[1]?.id === 'a')

    const fts = db.query<{ c: number }>("SELECT count(*) AS c FROM fts WHERE fts MATCH 'fox'").get()
    ok('FTS5 MATCH works', fts?.c === 1)

    // vec0 loadExtension (best-effort; mirrors how the app loads it).
    if (existsSync(join(process.cwd(), 'dist', 'native', 'vec0.dll'))) {
      let loaded = true
      try {
        db.loadExtension(join(process.cwd(), 'dist', 'native', 'vec0.dll'))
        db.run('CREATE VIRTUAL TABLE v USING vec0(id TEXT PRIMARY KEY, embedding float[4])')
      } catch (e) {
        loaded = false
        console.log('   vec0 load error:', String(e))
      }
      ok('vec0 loadExtension + vec0 table on encrypted DB', loaded)
    }
    db.close()
  }

  // 2. Reopen WITH key -> reads back.
  {
    const db = new Database(dbPath, { readonly: true, key: KEY })
    const c = db.query<{ c: number }>('SELECT count(*) AS c FROM t').get()
    ok('reopen with correct key reads data', c?.c === 2)
    db.close()
  }

  // 3. Reopen WITHOUT key -> NOTADB on first read.
  {
    let code = -1
    try {
      const db = new Database(dbPath, { readonly: true })
      db.query('SELECT count(*) FROM t').get()
      db.close()
    } catch (e) {
      code = e instanceof SqliteError ? e.code : -2
    }
    ok('open without key -> NOTADB', code === SQLITE_NOTADB)
  }

  // 4. Reopen with WRONG key -> NOTADB.
  {
    let code = -1
    try {
      const db = new Database(dbPath, { readonly: true, key: WRONG })
      db.query('SELECT count(*) FROM t').get()
      db.close()
    } catch (e) {
      code = e instanceof SqliteError ? e.code : -2
    }
    ok('open with wrong key -> NOTADB', code === SQLITE_NOTADB)
  }

  // 5. Plaintext -> encrypted migration via copy + PRAGMA rekey (in place).
  {
    const plainPath = join(dir, 'plain.db')
    const plain = new Database(plainPath, { create: true })
    plain.run('CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT)')
    plain.run("INSERT INTO m (id, v) VALUES (1, 'hello')")
    plain.close()

    const encPath = join(dir, 'plain.db.enc')
    copyFileSync(plainPath, encPath)
    const hex = KEY.toString('hex')
    const rekey = new Database(encPath, {})
    try {
      rekey.run("PRAGMA cipher = 'sqlcipher';")
      rekey.run(`PRAGMA rekey = "x'${hex}'";`)
    } catch (e) {
      console.log('   migration error:', String(e))
    } finally {
      rekey.close()
    }

    const enc = new Database(encPath, { key: KEY })
    const v = enc.query<{ v: string }>('SELECT v FROM m WHERE id = 1').get()
    ok('migration via copy + PRAGMA rekey', v?.v === 'hello')
    enc.close()

    // And the encrypted output is not readable as plaintext.
    let code = -1
    try {
      const db = new Database(encPath, { readonly: true })
      db.query('SELECT v FROM m').get()
      db.close()
    } catch (e) {
      code = e instanceof SqliteError ? e.code : -2
    }
    ok('migrated DB is encrypted (plaintext open -> NOTADB)', code === SQLITE_NOTADB)
  }
} finally {
  // Windows releases file handles slightly after close(); retry the cleanup.
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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
