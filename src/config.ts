import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { defaultConfigPath, expandHome, legacyConfigPath } from './util/paths'

export interface ScreenCaptureConfig {
  enabled: boolean
  interval_ms: number
  monitor: 'primary' | 'all' | number
  format: 'png' | 'jpg' | 'webp'
  // Lossy quality (1-100). Used by JPEG and WebP; ignored when format is png.
  quality: number
  // Downscale captures to fit this width in pixels; 0 keeps native resolution.
  max_width: number
}

type SystemAudioBackend = 'auto' | 'wasapi' | 'dshow'
type AudioStorageFormat = 'webm' | 'wav'

export interface AudioStreamConfig {
  enabled: boolean
  device: string
  chunk_ms: number
  // Only meaningful for the system stream on Windows. Selects how system audio
  // is captured: 'auto' prefers the WASAPI loopback helper (keeps capturing
  // when output is muted) and falls back to DirectShow; 'dshow' forces the
  // legacy virtual-audio-capturer path.
  backend?: SystemAudioBackend
}

export interface AudioCaptureConfig {
  sample_rate: number
  // Stored audio blob format. The ASR pipeline still receives raw PCM.
  format: AudioStorageFormat
  // Opus bitrate in kbps when format is webm. Ignored for wav.
  bitrate_kbps: number
  echo_suppression: {
    enabled: boolean
    system_threshold_db: number
    mic_margin_db: number
    hold_ms: number
  }
  mic: AudioStreamConfig
  system: AudioStreamConfig
}

export interface EngineConfig {
  engine: string
  options?: Record<string, unknown>
}

interface McpConfig {
  transport: 'stdio' | 'http'
  bind: string
  port: number
  auth: {
    enabled: boolean
  }
}

export interface UpdateConfig {
  // Check GitHub Releases for a newer version on `hpm start` and notify only —
  // never auto-install. Disable here, or set HPM_NO_UPDATE_CHECK=1 / run under
  // CI. `hpm update` checks on demand regardless of this flag.
  check: boolean
}

export interface Config {
  capture: {
    screen: ScreenCaptureConfig
    audio: AudioCaptureConfig
  }
  processing: {
    ocr: EngineConfig
    transcription: EngineConfig
    embeddings: EngineConfig
  }
  storage: {
    path: string
    // Encrypt captured data at rest. The master key lives in the OS keychain.
    // `database` controls the index DB (SQLCipher via SQLite3MultipleCiphers,
    // #12); `blobs` controls screenshot/audio files (AES-256-GCM, #54). When a
    // flag is on, existing plaintext data is migrated in place on start; when
    // off, the daemon never auto-decrypts — use `hpm decrypt` for that.
    encryption: {
      database: boolean
      blobs: boolean
    }
  }
  mcp: McpConfig
  update: UpdateConfig
}

const defaultConfig: Config = {
  capture: {
    screen: {
      enabled: true,
      interval_ms: 5000,
      monitor: 'primary',
      format: 'webp',
      quality: 80,
      max_width: 0,
    },
    audio: {
      sample_rate: 16000,
      format: 'webm',
      bitrate_kbps: 24,
      echo_suppression: {
        enabled: true,
        system_threshold_db: -45,
        mic_margin_db: 6,
        hold_ms: 500,
      },
      mic: { enabled: true, device: 'default', chunk_ms: 5000 },
      system: { enabled: true, device: 'default', chunk_ms: 5000, backend: 'auto' },
    },
  },
  processing: {
    ocr: { engine: 'auto', options: { lang: 'eng' } },
    transcription: {
      engine: 'parakeet',
      options: {
        model: 'parakeet-tdt-0.6b-v3',
        live: {
          enabled: true,
          min_segment_ms: 750,
          target_segment_ms: 4000,
          max_segment_ms: 6000,
          silence_ms: 700,
          rms_gate: 0.003,
        },
      },
    },
    embeddings: {
      engine: 'local',
      options: {
        model: 'multilingual-e5-small',
        dim: 384,
        batch_size: 16,
        sources: ['screen', 'mic', 'system'],
      },
    },
  },
  storage: {
    path: '~/.hyprmnesia/data',
    encryption: {
      database: true,
      blobs: true,
    },
  },
  mcp: {
    transport: 'stdio',
    bind: '127.0.0.1',
    port: 37373,
    auth: {
      enabled: true,
    },
  },
  update: {
    check: true,
  },
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const DEFAULT_PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3'
const LEGACY_TRANSCRIPTION_ENGINES = new Set(['auto', 'whisper'])
const SUPPORTED_TRANSCRIPTION_ENGINES = new Set(['parakeet', 'noop'])

const DEFAULT_EMBEDDING_MODEL = 'multilingual-e5-small'
const DEFAULT_EMBEDDING_DIM = 384
const SUPPORTED_EMBEDDING_ENGINES = new Set(['local', 'noop'])

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  if (override === null || override === undefined) return base
  if (typeof base !== 'object' || base === null) return (override as T) ?? base
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge((base as Record<string, unknown>)[k], v as DeepPartial<unknown>)
    } else if (v !== undefined) {
      out[k] = v
    }
  }
  return out as T
}

export function loadConfig(path?: string): Config {
  const merged = loadMergedConfig(path)
  merged.storage.path = expandHome(merged.storage.path)
  return merged
}

export function loadConfigForEditing(path?: string): Config {
  return loadMergedConfig(path)
}

function loadMergedConfig(path?: string): Config {
  const p = resolveConfigPath(path)
  ensureConfigFile(p)
  const raw = readFileSync(p, 'utf8')
  const parsed = parseConfig(raw, p)
  migrateLegacyEncryption(parsed)
  return normalizeConfig(deepMerge(defaultConfig, parsed))
}

// Maps the legacy single `storage.encryption.enabled` flag (shipped in #56) onto
// the split database/blobs flags on the raw config, BEFORE merging with defaults
// — otherwise the defaults' database/blobs=true would mask the user's intent.
function migrateLegacyEncryption(parsed: DeepPartial<Config>): void {
  const enc = parsed.storage?.encryption as
    | { enabled?: unknown; database?: unknown; blobs?: unknown }
    | undefined
  const legacy = typeof enc?.enabled === 'boolean' ? enc.enabled : undefined
  if (!enc || legacy === undefined) return
  if (typeof enc.database !== 'boolean') enc.database = legacy
  if (typeof enc.blobs !== 'boolean') enc.blobs = legacy
  enc.enabled = undefined
}

function normalizeConfig(config: Config): Config {
  const screen = config.capture.screen
  if (screen.format !== 'png' && screen.format !== 'jpg' && screen.format !== 'webp')
    screen.format = 'webp'
  if (!Number.isFinite(screen.quality)) screen.quality = defaultConfig.capture.screen.quality
  screen.quality = Math.max(1, Math.min(100, Math.trunc(screen.quality)))
  if (!Number.isFinite(screen.max_width) || screen.max_width < 0) screen.max_width = 0
  screen.max_width = Math.trunc(screen.max_width)

  const audio = config.capture.audio
  if (audio.format !== 'webm' && audio.format !== 'wav') audio.format = 'webm'
  if (!Number.isFinite(audio.bitrate_kbps))
    audio.bitrate_kbps = defaultConfig.capture.audio.bitrate_kbps
  audio.bitrate_kbps = Math.max(6, Math.min(256, Math.trunc(audio.bitrate_kbps)))

  const tx = config.processing.transcription
  if (LEGACY_TRANSCRIPTION_ENGINES.has(tx.engine)) tx.engine = 'parakeet'
  if (!SUPPORTED_TRANSCRIPTION_ENGINES.has(tx.engine)) tx.engine = 'parakeet'
  if (tx.engine === 'parakeet') {
    tx.options ??= {}
    if (tx.options.model !== DEFAULT_PARAKEET_MODEL) tx.options.model = DEFAULT_PARAKEET_MODEL
    tx.options.live = deepMerge(
      (defaultConfig.processing.transcription.options?.live ?? {}) as Record<string, unknown>,
      (tx.options.live && typeof tx.options.live === 'object' ? tx.options.live : {}) as Record<
        string,
        unknown
      >,
    )
  }
  const emb = config.processing.embeddings
  if (!emb || typeof emb !== 'object') {
    config.processing.embeddings = deepMerge(defaultConfig.processing.embeddings, {})
  } else {
    if (!SUPPORTED_EMBEDDING_ENGINES.has(emb.engine)) emb.engine = 'local'
    if (emb.engine === 'local') {
      emb.options ??= {}
      // v1 locks the model/dim pair; the vec0 schema is built for 384 dims.
      emb.options.model = DEFAULT_EMBEDDING_MODEL
      emb.options.dim = DEFAULT_EMBEDDING_DIM
    }
  }

  if (!config.storage.encryption || typeof config.storage.encryption !== 'object') {
    config.storage.encryption = { ...defaultConfig.storage.encryption }
  }
  {
    // Migrate the legacy single `enabled` flag (shipped in #56) to the split
    // database/blobs shape, then drop it.
    const enc = config.storage.encryption as {
      enabled?: unknown
      database?: unknown
      blobs?: unknown
    }
    const legacy = typeof enc.enabled === 'boolean' ? enc.enabled : undefined
    const database =
      typeof enc.database === 'boolean'
        ? enc.database
        : (legacy ?? defaultConfig.storage.encryption.database)
    const blobs =
      typeof enc.blobs === 'boolean'
        ? enc.blobs
        : (legacy ?? defaultConfig.storage.encryption.blobs)
    config.storage.encryption = { database, blobs }
  }

  if (config.mcp.transport !== 'stdio' && config.mcp.transport !== 'http')
    config.mcp.transport = 'stdio'
  if (typeof config.mcp.bind !== 'string' || config.mcp.bind.trim() === '')
    config.mcp.bind = '127.0.0.1'
  config.mcp.bind = config.mcp.bind.trim()
  if (!Number.isFinite(config.mcp.port)) config.mcp.port = defaultConfig.mcp.port
  config.mcp.port = Math.max(1, Math.min(65535, Math.trunc(config.mcp.port)))
  if (!config.mcp.auth || typeof config.mcp.auth !== 'object') {
    config.mcp.auth = { ...defaultConfig.mcp.auth }
  }
  if (typeof config.mcp.auth.enabled !== 'boolean') {
    config.mcp.auth.enabled = defaultConfig.mcp.auth.enabled
  }

  if (!config.update || typeof config.update !== 'object') {
    config.update = { ...defaultConfig.update }
  }
  if (typeof config.update.check !== 'boolean') {
    config.update.check = defaultConfig.update.check
  }
  return config
}

export function saveConfig(config: Config, path?: string): void {
  const p = resolveConfigPath(path)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, serializeConfig(config, p))
}

export function ensureDefaultConfig(path?: string): string {
  const p = resolveConfigPath(path)
  ensureConfigFile(p)
  return p
}

function configToYaml(config: Config = defaultConfig): string {
  return `# Hyprmnesia configuration\n# Changes apply after restarting the related daemon or MCP server.\n\n${stringifyYaml(config)}`
}

function resolveConfigPath(path?: string): string {
  return expandHome(path ?? defaultConfigPath())
}

function parseConfig(raw: string, path: string): DeepPartial<Config> {
  if (extname(path).toLowerCase() === '.json') return JSON.parse(raw) as DeepPartial<Config>
  return (parseYaml(raw) ?? {}) as DeepPartial<Config>
}

function serializeConfig(config: Config, path: string): string {
  if (extname(path).toLowerCase() === '.json') return `${JSON.stringify(config, null, 2)}\n`
  return configToYaml(config)
}

function ensureConfigFile(path: string): void {
  if (existsSync(path)) return

  // Smooth migration path: if the old JSON default exists, create the YAML
  // default from its merged values and keep the JSON untouched.
  if (path === defaultConfigPath() && existsSync(legacyConfigPath())) {
    const legacyRaw = readFileSync(legacyConfigPath(), 'utf8')
    const legacy = deepMerge(defaultConfig, JSON.parse(legacyRaw) as DeepPartial<Config>)
    saveConfig(legacy, path)
    return
  }

  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeConfig(defaultConfig, path))
}
