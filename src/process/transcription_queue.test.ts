import { expect, test } from 'bun:test'
import { EventBus } from '../core/events'
import type { ChunkStore } from '../store/db'
import { TranscriptionQueue } from './transcription_queue'
import type { PcmAudioFrame, TranscriptionEngine } from './types'

test('submitPcm drops frames while replay transcription is suppressed', async () => {
  const submitted: PcmAudioFrame[] = []
  const flushed: unknown[] = []
  let suppressed = false

  const engine: TranscriptionEngine = {
    name: 'test-asr',
    ready: async () => true,
    start: async () => {},
    submitPcm: (frame) => submitted.push(frame),
    flush: async (source) => {
      flushed.push(source ?? 'all')
    },
    stop: async () => {},
  }

  const queue = new TranscriptionQueue(engine, {} as ChunkStore, new EventBus(), {
    isReplaySuppressed: () => suppressed,
  })
  await queue.start()

  const frame: PcmAudioFrame = {
    source: 'system',
    chunkId: 'chunk-1',
    at: Date.UTC(2026, 0, 1),
    sampleRate: 16_000,
    pcm: Buffer.alloc(960),
  }

  queue.submitPcm(frame)
  expect(submitted).toHaveLength(1)

  suppressed = true
  queue.submitPcm(frame)
  queue.submitPcm(frame)
  await Promise.resolve()

  expect(submitted).toHaveLength(1)
  expect(flushed).toEqual(['system'])

  suppressed = false
  queue.submitPcm(frame)
  expect(submitted).toHaveLength(2)
})
