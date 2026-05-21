import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface BlobStore {
  path(kind: string, id: string, ext: string, at?: number): string
  write(kind: string, id: string, ext: string, data: Buffer, at?: number): Promise<string>
}

function partitionedDir(rootDir: string, kind: string, at = Date.now()): string {
  const now = new Date(at)
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return join(rootDir, kind, yyyy, mm, dd)
}

async function ensureDir(dir: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

export function makeBlobStore(rootDir: string): BlobStore {
  return {
    path(kind, id, ext, at) {
      return join(partitionedDir(rootDir, kind, at), `${id}.${ext}`)
    },
    async write(kind, id, ext, data, at) {
      const dir = partitionedDir(rootDir, kind, at)
      await ensureDir(dir)
      const path = join(dir, `${id}.${ext}`)
      await writeFile(path, data)
      return path
    },
  }
}
