// Produces the SQLite3MultipleCiphers ("sqlite3mc") shared library into
// dist/native so the bun:ffi shim (src/store/sqlcipher) can load it. This is the
// encryption-capable SQLite engine used when index-DB encryption is enabled
// (#12). bun:sqlite stays the engine for the unencrypted path.
//
// Windows: a prebuilt DLL ships in the upstream releases, so we fetch it.
// Linux/macOS: no prebuilt shared lib is published, so we compile the published
// amalgamation with a C compiler (cc/clang/gcc). The sqlite3mc codec is built
// into the amalgamation; we only add FTS5 etc. to match the bundled features.
//
// Zip extraction is done in-process (node:zlib) to avoid the cross-platform
// mess of tar/unzip availability (Windows ships GNU tar via git-bash that
// cannot read zips and treats `C:` as a remote host).
//
// Run directly (`bun run scripts/build-sqlcipher.ts`) for dev/CI, or import
// `ensureSqliteCipher` from build.ts during packaging.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { $ } from 'bun'

// Pinned versions; bump together. Asset names embed both.
const SQLITE3MC_VERSION = '2.3.4'
const SQLITE_VERSION = '3.53.1'
const BASE_URL = `https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v${SQLITE3MC_VERSION}`
const CACHE_DIR = resolve('./.cache/sqlite3mc')

export function sqlcipherLibName(): string {
  if (process.platform === 'win32') return 'sqlite3mc.dll'
  if (process.platform === 'darwin') return 'libsqlite3mc.dylib'
  return 'libsqlite3mc.so'
}

// Ensures the library exists in destDir, fetching/compiling it if missing.
// Returns the absolute path, or undefined on an unsupported platform/arch.
export async function ensureSqliteCipher(
  destDir: string = resolve('./dist/native'),
): Promise<string | undefined> {
  const dest = join(destDir, sqlcipherLibName())
  if (existsSync(dest)) return dest
  await mkdir(destDir, { recursive: true })
  await mkdir(CACHE_DIR, { recursive: true })
  if (process.platform === 'win32') return fetchPrebuiltWindows(dest)
  if (process.platform === 'darwin' || process.platform === 'linux') return compileFromSource(dest)
  console.warn(`sqlite3mc: unsupported platform ${process.platform}; encryption unavailable`)
  return undefined
}

async function fetchPrebuiltWindows(dest: string): Promise<string> {
  if (process.arch !== 'x64') throw new Error(`sqlite3mc: no prebuilt for win32/${process.arch}`)
  const asset = `sqlite3mc-${SQLITE3MC_VERSION}-sqlite-${SQLITE_VERSION}-win64.zip`
  const zip = join(CACHE_DIR, asset)
  await download(`${BASE_URL}/${asset}`, zip)
  const dll = extractEntry(zip, 'dll/sqlite3mc_x64.dll')
  writeFileSync(dest, dll)
  return dest
}

async function compileFromSource(dest: string): Promise<string> {
  const asset = `sqlite3mc-${SQLITE3MC_VERSION}-sqlite-${SQLITE_VERSION}-amalgamation.zip`
  const zip = join(CACHE_DIR, asset)
  await download(`${BASE_URL}/${asset}`, zip)
  const outDir = join(CACHE_DIR, 'amalgamation')
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  for (const name of ['sqlite3mc_amalgamation.c', 'sqlite3mc_amalgamation.h']) {
    writeFileSync(join(outDir, name), extractEntry(zip, name))
  }

  const cc = process.env.CC || 'cc'
  const src = join(outDir, 'sqlite3mc_amalgamation.c')
  // Match the feature set the codebase needs. The codec is baked into the
  // amalgamation; load_extension stays enabled (only the VxWorks/OS-other blocks
  // omit it). Runtime extension loading is still gated by the shim.
  const flags = [
    '-O2',
    '-fPIC',
    '-DSQLITE_ENABLE_FTS5',
    '-DSQLITE_ENABLE_RTREE',
    '-DSQLITE_ENABLE_COLUMN_METADATA',
    '-DSQLITE_ENABLE_MATH_FUNCTIONS',
    '-DSQLITE_THREADSAFE=1',
  ]
  if (process.platform === 'darwin') {
    await $`${cc} ${flags} -dynamiclib ${src} -o ${dest} -lpthread`
  } else {
    await $`${cc} ${flags} -shared ${src} -o ${dest} -lpthread -ldl -lm`
  }
  return dest
}

async function download(url: string, dest: string): Promise<void> {
  if (existsSync(dest)) return
  await mkdir(dirname(dest), { recursive: true })
  const res = await fetch(url)
  if (!res.ok) throw new Error(`sqlite3mc: download failed (HTTP ${res.status}): ${url}`)
  await Bun.write(dest, await res.arrayBuffer())
}

// Minimal ZIP reader: extracts a single entry by name. Handles store (0) and
// deflate (8), which is all the upstream archives use. No ZIP64 (assets < 4GB).
function extractEntry(zipPath: string, name: string): Buffer {
  const buf = readFileSync(zipPath)
  // Locate End Of Central Directory record (scan back for its signature).
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`sqlite3mc: invalid zip ${zipPath}`)
  const entryCount = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16) // central directory offset
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const entryName = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const comp = buf.subarray(dataStart, dataStart + compSize)
      return method === 0 ? Buffer.from(comp) : inflateRawSync(comp)
    }
    p += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`sqlite3mc: entry not found in zip: ${name}`)
}

if (import.meta.main) {
  const dest = await ensureSqliteCipher()
  console.log(dest ? `sqlite3mc ready: ${dest}` : 'sqlite3mc: skipped (unsupported platform)')
}
