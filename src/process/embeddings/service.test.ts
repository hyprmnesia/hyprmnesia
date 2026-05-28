import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import type {
  EmbeddingCallbacks,
  EmbeddingEngine,
  EmbeddingRequest,
  EmbeddingResult,
} from '../types'
import { openSharedEmbeddingClient } from './client'
import { readEmbedEndpoint } from './endpoint'
import { createEmbeddingService } from './service'

const dirs: string[] = []

class FakeEngine implements EmbeddingEngine {
  readonly name = 'fake:test'
  readonly dim = 4
  calls = 0
  embedImpl: (req: EmbeddingRequest) => Float32Array = (req) =>
    Float32Array.from([req.text.length, 1, 2, 3])

  async ready(): Promise<boolean> {
    return true
  }
  async start(_callbacks: EmbeddingCallbacks): Promise<void> {}
  async embed(requests: EmbeddingRequest[]): Promise<EmbeddingResult[]> {
    this.calls += 1
    return requests.map((req) => ({
      id: req.id,
      kind: req.kind,
      vector: this.embedImpl(req),
    }))
  }
  async stop(): Promise<void> {}
}

function pickSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\hpm-embed-test-${randomUUIDv7()}`
  }
  const dir = mkdtempSync(join(tmpdir(), 'hpm-embed-svc-'))
  dirs.push(dir)
  return join(dir, 'embed.sock')
}

function pickEndpointPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hpm-embed-endpoint-'))
  dirs.push(dir)
  return join(dir, 'embed.endpoint.json')
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  }
})

test('shared embed RPC round-trips a query vector through a single worker', async () => {
  const engine = new FakeEngine()
  const service = createEmbeddingService(engine, undefined, { socketPath: pickSocketPath() })
  await service.start()
  try {
    const endpoint = service.endpoint()
    expect(endpoint).toBeDefined()
    expect(endpoint?.dim).toBe(engine.dim)

    const client = await openSharedEmbeddingClient({ endpoint })
    try {
      const a = await client.encodeQuery('hello')
      const b = await client.encodeQuery('this is a longer query')
      expect(a).toBeInstanceOf(Float32Array)
      expect(Array.from(a)).toEqual([5, 1, 2, 3])
      expect(Array.from(b)).toEqual([22, 1, 2, 3])
      expect(engine.calls).toBe(2)
    } finally {
      client.close()
    }
  } finally {
    await service.stop()
  }
})

test('start() publishes endpoint file, stop() removes it', async () => {
  const engine = new FakeEngine()
  const endpointPath = pickEndpointPath()
  const service = createEmbeddingService(engine, undefined, {
    socketPath: pickSocketPath(),
    endpointPath,
  })
  await service.start()
  expect(readEmbedEndpoint(endpointPath)?.socket).toBe(service.endpoint()?.socket ?? '')
  await service.stop()
  expect(readEmbedEndpoint(endpointPath)).toBeUndefined()
})

test('engine errors surface as client rejections without breaking the connection', async () => {
  const engine = new FakeEngine()
  engine.embedImpl = () => {
    throw new Error('synthetic engine failure')
  }
  const service = createEmbeddingService(engine, undefined, { socketPath: pickSocketPath() })
  await service.start()
  try {
    const client = await openSharedEmbeddingClient({ endpoint: service.endpoint() })
    try {
      await expect(client.encodeQuery('boom')).rejects.toThrow('synthetic engine failure')
      // Recover from a queued failure with a healthy call afterwards.
      engine.embedImpl = (req) => Float32Array.from([req.text.length, 9, 9, 9])
      const recovered = await client.encodeQuery('ok')
      expect(Array.from(recovered)).toEqual([2, 9, 9, 9])
    } finally {
      client.close()
    }
  } finally {
    await service.stop()
  }
})

test('client refuses to connect when no endpoint is reachable', async () => {
  const missing = pickSocketPath()
  await expect(
    openSharedEmbeddingClient({
      endpoint: {
        socket: missing,
        pid: 999_999,
        engine: 'fake:test',
        dim: 4,
        protocol: 'embed/1',
        started_at: Date.now(),
      },
      connectTimeoutMs: 200,
    }),
  ).rejects.toThrow()
})
