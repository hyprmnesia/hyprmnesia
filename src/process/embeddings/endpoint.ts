import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'

const HOME_DIR = join(homedir(), '.hyprmnesia')
const ENDPOINT_FILE = join(HOME_DIR, 'embed.endpoint.json')

export interface EmbedEndpoint {
  socket: string
  pid: number
  engine: string
  dim: number
  protocol: string
  started_at: number
}

// Per-user named pipe / socket address. On POSIX we use a Unix domain socket
// in ~/.hyprmnesia; on Windows we use a named pipe scoped by a stable hash of
// the user identity so concurrent users on the same host don't collide.
export function defaultEmbedSocketPath(): string {
  if (process.platform === 'win32') {
    const account = process.env.USERNAME || userInfo().username || 'default'
    const tag = createHash('sha256').update(account).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\hyprmnesia-embed-${tag}`
  }
  return join(HOME_DIR, 'embed.sock')
}

export function writeEmbedEndpoint(endpoint: EmbedEndpoint, path = ENDPOINT_FILE): void {
  const dir = dirname(path)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(endpoint)}\n`, { mode: 0o600 })
}

export function clearEmbedEndpoint(path = ENDPOINT_FILE): void {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {}
}

export function readEmbedEndpoint(path = ENDPOINT_FILE): EmbedEndpoint | undefined {
  if (!existsSync(path)) return undefined
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (raw === '') return undefined
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const value = parsed as Record<string, unknown>
    if (
      typeof value.socket !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.engine !== 'string' ||
      typeof value.dim !== 'number' ||
      typeof value.protocol !== 'string' ||
      typeof value.started_at !== 'number'
    ) {
      return undefined
    }
    return {
      socket: value.socket,
      pid: value.pid,
      engine: value.engine,
      dim: value.dim,
      protocol: value.protocol,
      started_at: value.started_at,
    }
  } catch {
    return undefined
  }
}
