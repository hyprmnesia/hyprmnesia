import type { AudioSource } from '../core/events'

export interface OcrEngine {
  readonly name: string
  ready(): Promise<boolean>
  process(image: Buffer): Promise<string>
}

export interface PcmAudioFrame {
  source: AudioSource
  chunkId: string
  at: number
  sampleRate: number
  pcm: Buffer
}

export interface TranscriptionSegment {
  source: AudioSource
  chunkId: string
  startAt: number
  endAt: number
  text: string
  engine: string
  transcribeMs: number
}

export interface TranscriptionStatus {
  status: 'starting' | 'downloading' | 'loading' | 'ready' | 'error' | 'stopped'
  engine: string
  message?: string
}

export interface TranscriptionCallbacks {
  onSegment(segment: TranscriptionSegment): void
  onStatus(status: TranscriptionStatus): void
}

export interface TranscriptionEngine {
  readonly name: string
  ready(): Promise<boolean>
  start(callbacks: TranscriptionCallbacks): Promise<void>
  submitPcm(frame: PcmAudioFrame): void
  flush(source?: AudioSource): Promise<void>
  stop(): Promise<void>
}
