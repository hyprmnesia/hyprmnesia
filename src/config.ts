import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { defaultConfigPath, expandHome, legacyConfigPath } from './util/paths'

export interface ScreenCaptureConfig {
  enabled: boolean
  interval_ms: number
  monitor: 'primary' | 'all' | number
  format: 'png' | 'jpg'
}

export interface AudioStreamConfig {
  enabled: boolean
  device: string
  chunk_ms: number
}

export interface AudioCaptureConfig {
  sample_rate: number
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
}

export interface Config {
  capture: {
    screen: ScreenCaptureConfig
    audio: AudioCaptureConfig
  }
  processing: {
    ocr: EngineConfig
    transcription: EngineConfig
  }
  storage: {
    path: string
  }
  mcp: McpConfig
}

const defaultConfig: Config = {
  capture: {
    screen: {
      enabled: true,
      interval_ms: 5000,
      monitor: 'primary',
      format: 'png',
    },
    audio: {
      sample_rate: 16000,
      echo_suppression: {
        enabled: true,
        system_threshold_db: -45,
        mic_margin_db: 6,
        hold_ms: 500,
      },
      mic: { enabled: true, device: 'default', chunk_ms: 5000 },
      system: { enabled: true, device: 'default', chunk_ms: 5000 },
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
  },
  storage: {
    path: '~/.hyprmnesia/data',
  },
  mcp: {
    transport: 'stdio',
    bind: '127.0.0.1',
    port: 37373,
  },
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const DEFAULT_PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3'
const LEGACY_TRANSCRIPTION_ENGINES = new Set(['auto', 'whisper'])
const SUPPORTED_TRANSCRIPTION_ENGINES = new Set(['parakeet', 'noop'])

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
  return normalizeConfig(deepMerge(defaultConfig, parsed))
}

function normalizeConfig(config: Config): Config {
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
  if (config.mcp.transport !== 'stdio' && config.mcp.transport !== 'http')
    config.mcp.transport = 'stdio'
  if (typeof config.mcp.bind !== 'string' || config.mcp.bind.trim() === '')
    config.mcp.bind = '127.0.0.1'
  config.mcp.bind = config.mcp.bind.trim()
  if (!Number.isFinite(config.mcp.port)) config.mcp.port = defaultConfig.mcp.port
  config.mcp.port = Math.max(1, Math.min(65535, Math.trunc(config.mcp.port)))
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
