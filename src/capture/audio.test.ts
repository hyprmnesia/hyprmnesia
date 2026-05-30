import { expect, test } from 'bun:test'
import { EventBus } from '../core/events'
import type { TranscriptionQueue } from '../process/transcription_queue'
import type { BlobStore } from '../store/blobs'
import type { ChunkStore } from '../store/db'
import { __testing } from './audio'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function sleep(ms: number): Promise<'pending'> {
  return new Promise((resolve) => setTimeout(() => resolve('pending'), ms))
}

test('audio consumer does not block PCM ingestion while a chunk blob is finalized', async () => {
  const writeGate = deferred<string>()
  const inserted: unknown[] = []
  const finalized: unknown[] = []

  const blobs: BlobStore = {
    path: (_kind, id, ext) => `/tmp/${id}.${ext}`,
    write: async () => writeGate.promise,
  }
  const store = {
    vecEnabled: false,
    insert: (row: unknown) => inserted.push(row),
    finalizeAudioChunk: (id: string, fields: unknown) => finalized.push({ id, fields }),
    insertTranscriptSegment: () => {},
    updateText: () => {},
    insertEmbedding: () => {},
    pendingEmbeddings: () => [],
    close: () => {},
  } as unknown as ChunkStore
  const transcription = {
    submitPcm: () => {},
    flush: async () => {},
  } as unknown as TranscriptionQueue

  const consumer = (__testing.makeAudioConsumer as any)({
    source: 'system',
    device: 'test-device',
    sampleRate: 1000,
    chunkMs: 10,
    storageFormat: 'wav',
    storageBitrateKbps: 24,
    blobs,
    store,
    transcription,
    events: new EventBus(),
    echo: {
      enabled: false,
      systemThresholdDb: -45,
      micMarginDb: 6,
      holdMs: 500,
      activeUntil: 0,
      lastSystemPeakDb: -Infinity,
    },
  })

  const fullChunkPcm = Buffer.alloc(20) // 10 mono i16 samples at 1 kHz = 10 ms.
  const append = consumer.appendPcm(fullChunkPcm)

  expect(await Promise.race([append.then(() => 'done' as const), sleep(20)])).toBe('done')
  expect(inserted).toHaveLength(1)
  expect(finalized).toHaveLength(0)

  const done = consumer.finalize()
  expect(await Promise.race([done.then(() => 'done' as const), sleep(20)])).toBe('pending')

  writeGate.resolve('/tmp/chunk.wav')
  await done
  expect(finalized).toHaveLength(1)
})
