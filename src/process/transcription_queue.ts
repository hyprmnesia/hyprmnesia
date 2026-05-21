// Bridges live PCM frames into the ASR engine and persists final transcript
// segments. Capture never waits on transcription; the engine owns its own
// worker/process and emits final segments back through callbacks.

import { randomUUIDv7 } from 'bun'
import type { AudioSource, EventBus } from '../core/events'
import type { ChunkStore } from '../store/db'
import type {
  PcmAudioFrame,
  TranscriptionEngine,
  TranscriptionSegment,
  TranscriptionStatus,
} from './types'

export class TranscriptionQueue {
  constructor(
    private engine: TranscriptionEngine,
    private store: ChunkStore,
    private events: EventBus,
  ) {}

  async start(): Promise<void> {
    await this.engine.start({
      onSegment: (segment) => this.handleSegment(segment),
      onStatus: (status) => this.handleStatus(status),
    })
  }

  submitPcm(frame: PcmAudioFrame): void {
    this.engine.submitPcm(frame)
  }

  async flush(source?: AudioSource): Promise<void> {
    await this.engine.flush(source)
  }

  async stop(): Promise<void> {
    await this.engine.flush().catch((err) => {
      this.events.publish({
        type: 'log',
        at: Date.now(),
        level: 'warn',
        message: `ASR flush failed during stop: ${err}`,
      })
    })
    await this.engine.stop().catch((err) => {
      this.events.publish({
        type: 'log',
        at: Date.now(),
        level: 'warn',
        message: `ASR stop failed: ${err}`,
      })
    })
  }

  private handleStatus(status: TranscriptionStatus): void {
    this.events.publish({
      type: 'transcription_status',
      at: Date.now(),
      status: status.status,
      engine: status.engine,
      message: status.message,
    })
  }

  private handleSegment(segment: TranscriptionSegment): void {
    const id = randomUUIDv7()
    const text = segment.text.trim()
    if (!text) return

    try {
      this.store.insertTranscriptSegment({
        id,
        chunk_id: segment.chunkId,
        source: segment.source,
        start_at: segment.startAt,
        end_at: segment.endAt,
        text,
        engine: segment.engine,
        transcribe_ms: segment.transcribeMs,
      })
    } catch (err) {
      this.events.publish({
        type: 'error',
        source: segment.source,
        at: Date.now(),
        message: `transcript segment insert failed for ${segment.chunkId}: ${err}`,
      })
      return
    }

    this.events.publish({
      type: 'transcription_segment',
      source: segment.source,
      at: Date.now(),
      id,
      chunk_id: segment.chunkId,
      start_at: segment.startAt,
      end_at: segment.endAt,
      text,
      text_len: text.length,
      transcribe_ms: segment.transcribeMs,
      engine: segment.engine,
    })

    // Compatibility event for existing TUI/log consumers that expect final
    // chunk text on `transcribed`.
    this.events.publish({
      type: 'transcribed',
      source: segment.source,
      at: Date.now(),
      id: segment.chunkId,
      text,
      text_len: text.length,
      transcribe_ms: segment.transcribeMs,
      engine: segment.engine,
    })
  }
}
