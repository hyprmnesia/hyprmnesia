import { expect, test } from 'bun:test'
import { EmbedRpcUnavailable, type SharedEmbeddingClient } from '../process/embeddings/client'
import type {
  EmbeddingCallbacks,
  EmbeddingEngine,
  EmbeddingRequest,
  EmbeddingResult,
} from '../process/types'
import { makeQueryEncoder } from './server'

interface FakeEngineHooks {
  ready?: boolean
  embed?: (req: EmbeddingRequest) => Float32Array
  onStart?: () => void
  onStop?: () => void
}

function fakeEngine(hooks: FakeEngineHooks = {}): EmbeddingEngine & { started: boolean } {
  const engine = {
    name: 'fake:standalone',
    dim: 4,
    started: false,
    async ready(): Promise<boolean> {
      return hooks.ready ?? true
    },
    async start(_cb: EmbeddingCallbacks): Promise<void> {
      hooks.onStart?.()
      engine.started = true
    },
    async embed(requests: EmbeddingRequest[]): Promise<EmbeddingResult[]> {
      return requests.map((req) => ({
        id: req.id,
        kind: req.kind,
        vector: (hooks.embed ?? ((r) => Float32Array.from([r.text.length, 0, 0, 0])))(req),
      }))
    },
    async stop(): Promise<void> {
      hooks.onStop?.()
      engine.started = false
    },
  }
  return engine
}

function fakeSharedClient(impl: (text: string) => Float32Array | Error): SharedEmbeddingClient {
  let closed = false
  return {
    async encodeQuery(text: string): Promise<Float32Array> {
      if (closed) throw new Error('client closed')
      const result = impl(text)
      if (result instanceof Error) throw result
      return result
    },
    close(): void {
      closed = true
    },
    endpoint() {
      return {
        socket: 'mock',
        pid: 1,
        engine: 'mock',
        dim: 4,
        protocol: 'embed/1',
        started_at: Date.now(),
      }
    },
  }
}

test('uses the daemon shared embed worker when available', async () => {
  const shared = fakeSharedClient((text) => Float32Array.from([text.length, 1, 1, 1]))
  const local = fakeEngine()
  const encoder = makeQueryEncoder({
    openShared: async () => shared,
    daemonAlive: () => true,
    makeLocalEngine: () => local,
  })

  const vector = await encoder.encode('hello')
  expect(vector).toBeInstanceOf(Float32Array)
  expect(Array.from(vector ?? new Float32Array())).toEqual([5, 1, 1, 1])
  expect(local.started).toBe(false)
  await encoder.stop()
})

test('falls back to FTS5 when daemon is alive but RPC fails - never spawns local', async () => {
  const local = fakeEngine()
  const encoder = makeQueryEncoder({
    openShared: async () =>
      fakeSharedClient(() => {
        throw new Error('rpc unhealthy')
      }),
    daemonAlive: () => true,
    makeLocalEngine: () => local,
  })

  const first = await encoder.encode('q1')
  expect(first).toBeUndefined()
  expect(local.started).toBe(false)
  // Subsequent calls remain on FTS5 without re-trying the RPC.
  const second = await encoder.encode('q2')
  expect(second).toBeUndefined()
  expect(local.started).toBe(false)
  await encoder.stop()
})

test('falls back to FTS5 when daemon is alive but no endpoint is reachable', async () => {
  let opened = false
  const local = fakeEngine()
  const encoder = makeQueryEncoder({
    openShared: async () => {
      opened = true
      throw new EmbedRpcUnavailable('no endpoint')
    },
    daemonAlive: () => true,
    makeLocalEngine: () => local,
  })

  const result = await encoder.encode('q')
  expect(result).toBeUndefined()
  expect(opened).toBe(true)
  expect(local.started).toBe(false)
  await encoder.stop()
})

test('without daemon, uses standalone local engine (preserves prior semantic behavior)', async () => {
  const local = fakeEngine({ embed: (req) => Float32Array.from([req.text.length, 2, 2, 2]) })
  const encoder = makeQueryEncoder({
    openShared: async () => {
      throw new EmbedRpcUnavailable('no endpoint')
    },
    daemonAlive: () => false,
    makeLocalEngine: () => local,
  })

  const vector = await encoder.encode('xy')
  expect(local.started).toBe(true)
  expect(Array.from(vector ?? new Float32Array())).toEqual([2, 2, 2, 2])
  await encoder.stop()
  expect(local.started).toBe(false)
})

test('returns undefined when daemon is dead and no local engine is available', async () => {
  const encoder = makeQueryEncoder({
    openShared: async () => {
      throw new EmbedRpcUnavailable('no endpoint')
    },
    daemonAlive: () => false,
    makeLocalEngine: () => undefined,
  })

  const vector = await encoder.encode('q')
  expect(vector).toBeUndefined()
  await encoder.stop()
})
