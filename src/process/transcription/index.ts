import type { EngineConfig } from '../../config'
import type { EventBus } from '../../core/events'
import type { TranscriptionEngine } from '../types'
import { AutoTranscription } from './auto'
import { NoopTranscription } from './noop'
import { normalizeParakeetModel, type ParakeetOptions, ParakeetTranscription } from './parakeet'

function liveOptionsFrom(value: unknown): ParakeetOptions['live'] {
  if (!value || typeof value !== 'object') return undefined
  const live = value as Record<string, unknown>
  return {
    enabled: typeof live.enabled === 'boolean' ? live.enabled : undefined,
    min_segment_ms: typeof live.min_segment_ms === 'number' ? live.min_segment_ms : undefined,
    target_segment_ms:
      typeof live.target_segment_ms === 'number' ? live.target_segment_ms : undefined,
    max_segment_ms: typeof live.max_segment_ms === 'number' ? live.max_segment_ms : undefined,
    silence_ms: typeof live.silence_ms === 'number' ? live.silence_ms : undefined,
    rms_gate: typeof live.rms_gate === 'number' ? live.rms_gate : undefined,
  }
}

function parakeetOptionsFrom(opts: Record<string, unknown>): ParakeetOptions {
  return {
    model: normalizeParakeetModel(opts.model),
    live: liveOptionsFrom(opts.live),
  }
}

export function makeTranscription(cfg: EngineConfig, events?: EventBus): TranscriptionEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'noop':
      return new NoopTranscription()
    case 'parakeet':
      return new ParakeetTranscription(parakeetOptionsFrom(opts), events)
    case 'auto':
    case 'whisper':
      return new AutoTranscription(parakeetOptionsFrom(opts), events)
    default:
      throw new Error(`unknown transcription engine: ${cfg.engine}`)
  }
}
