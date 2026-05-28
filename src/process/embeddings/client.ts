// MCP-side client for the daemon's embedding RPC. Connects to the daemon's
// Unix socket / Windows named pipe, performs an NDJSON request/response, and
// streams the resulting query vector back. A single client instance keeps the
// connection warm and serializes outstanding requests by id.

import { connect, type Socket } from 'node:net'
import { randomUUIDv7 } from 'bun'
import { type EmbedEndpoint, readEmbedEndpoint } from './endpoint'

const CONNECT_TIMEOUT_MS = 2_000
const REQUEST_TIMEOUT_MS = 30_000

type ServerMessage =
  | { type: 'hello'; protocol: string; engine: string; dim: number }
  | { id: string; result: { vector?: number[]; engine?: string; dim?: number; protocol?: string } }
  | { id: string; error: { message: string } }

interface Pending {
  resolve: (vector: Float32Array) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface SharedEmbeddingClient {
  encodeQuery(text: string): Promise<Float32Array>
  close(): void
  endpoint(): EmbedEndpoint
}

export class EmbedRpcUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EmbedRpcUnavailable'
  }
}

export interface OpenSharedClientOptions {
  endpoint?: EmbedEndpoint
  endpointPath?: string
  connectTimeoutMs?: number
}

export async function openSharedEmbeddingClient(
  opts: OpenSharedClientOptions = {},
): Promise<SharedEmbeddingClient> {
  const endpoint = opts.endpoint ?? readEmbedEndpoint(opts.endpointPath)
  if (!endpoint) throw new EmbedRpcUnavailable('no embed endpoint registered')
  const timeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS

  const socket = await openSocket(endpoint.socket, timeoutMs)
  socket.setEncoding('utf8')

  const pending = new Map<string, Pending>()
  let buffer = ''
  let closed = false
  let helloReceived = false

  const failAll = (err: Error) => {
    closed = true
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
      pending.delete(id)
    }
  }

  socket.on('data', (chunk: string) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let message: ServerMessage
      try {
        message = JSON.parse(trimmed) as ServerMessage
      } catch {
        continue
      }
      if ('type' in message && message.type === 'hello') {
        helloReceived = true
        continue
      }
      if ('id' in message) {
        const entry = pending.get(message.id)
        if (!entry) continue
        pending.delete(message.id)
        clearTimeout(entry.timer)
        if ('error' in message) {
          entry.reject(new Error(message.error.message))
        } else {
          const vector = message.result.vector
          if (!Array.isArray(vector)) {
            entry.reject(new Error('missing vector in embed response'))
          } else {
            entry.resolve(Float32Array.from(vector))
          }
        }
      }
    }
  })
  socket.on('error', (err) => failAll(err instanceof Error ? err : new Error(String(err))))
  socket.on('close', () => failAll(new Error('embed socket closed')))

  // Wait briefly for the hello frame so callers immediately see a healthy
  // server before issuing the first query. If hello never arrives we treat
  // the endpoint as unavailable.
  try {
    await waitForHello(
      () => helloReceived,
      () => closed,
      timeoutMs,
    )
  } catch (err) {
    socket.destroy()
    throw err
  }

  const encodeQuery = (text: string): Promise<Float32Array> => {
    if (closed) return Promise.reject(new EmbedRpcUnavailable('embed socket closed'))
    return new Promise<Float32Array>((resolve, reject) => {
      const id = randomUUIDv7()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`embed request timed out after ${REQUEST_TIMEOUT_MS}ms`))
      }, REQUEST_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      const payload = JSON.stringify({ id, method: 'embed_query', params: { text } })
      socket.write(`${payload}\n`, (err) => {
        if (err) {
          clearTimeout(timer)
          pending.delete(id)
          reject(err)
        }
      })
    })
  }

  const close = () => {
    if (closed) return
    closed = true
    try {
      socket.end()
    } catch {}
    failAll(new Error('embed client closed'))
  }

  return { encodeQuery, close, endpoint: () => endpoint }
}

function openSocket(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = connect(path)
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new EmbedRpcUnavailable(`embed connect timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(new EmbedRpcUnavailable(err instanceof Error ? err.message : String(err)))
    })
  })
}

function waitForHello(
  isReady: () => boolean,
  isClosed: () => boolean,
  timeoutMs: number,
): Promise<void> {
  if (isReady()) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (isReady()) return resolve()
      if (isClosed()) return reject(new EmbedRpcUnavailable('embed socket closed before hello'))
      if (Date.now() - start > timeoutMs)
        return reject(new EmbedRpcUnavailable('timed out waiting for embed hello'))
      setTimeout(tick, 20)
    }
    tick()
  })
}
