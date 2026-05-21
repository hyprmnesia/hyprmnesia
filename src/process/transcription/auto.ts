import type { AudioSource, EventBus } from '../../core/events'
import type { PcmAudioFrame, TranscriptionCallbacks, TranscriptionEngine } from '../types'
import { type ParakeetOptions, ParakeetTranscription } from './parakeet'

// auto-pick now means Parakeet-only. The name is kept for old config files.
// the chosen engine is locked at the first ready() call.

export class AutoTranscription implements TranscriptionEngine {
  readonly name = 'auto'
  private chosen?: TranscriptionEngine
  private chosenName?: string

  constructor(
    private parakeetOpts: ParakeetOptions = {},
    private events?: EventBus,
  ) {}

  async ready(): Promise<boolean> {
    if (this.chosen) return true
    const parakeet = new ParakeetTranscription(this.parakeetOpts, this.events)
    if (await parakeet.ready()) {
      this.chosen = parakeet
      this.chosenName = parakeet.name
      return true
    }
    return false
  }

  private async engine(): Promise<TranscriptionEngine> {
    if (!this.chosen) {
      const ok = await this.ready()
      if (!ok) throw new Error('no transcription engine available')
    }
    return this.chosen!
  }

  async start(callbacks: TranscriptionCallbacks): Promise<void> {
    return (await this.engine()).start(callbacks)
  }

  submitPcm(frame: PcmAudioFrame): void {
    this.chosen?.submitPcm(frame)
  }

  async flush(source?: AudioSource): Promise<void> {
    await this.chosen?.flush(source)
  }

  async stop(): Promise<void> {
    await this.chosen?.stop()
  }

  resolvedName(): string | undefined {
    return this.chosenName
  }
}
