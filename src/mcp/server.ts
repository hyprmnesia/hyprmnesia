import { defaultDbPath, expandHome } from '../util/paths'
import { type JsonRpcId, type JsonRpcRequest, type JsonRpcResponse, StdioJsonRpc } from './protocol'
import {
  clampLimit,
  clampOffset,
  normalizeSource,
  parseTimestamp,
  ReadStoreError,
  withReadStore,
} from './read_store'

const PROTOCOL_VERSION = '2025-06-18'
const TOOLS = [
  {
    name: 'search',
    description:
      'Search OCR text, active window context, and transcript segments in the local Hyprmnesia index.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Plain text query. Terms are ANDed for FTS5 search.',
        },
        from: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Optional ISO date or epoch-ms lower bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        to: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Optional ISO date or epoch-ms upper bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        source: {
          type: 'string',
          enum: ['screen', 'mic', 'system'],
          description: 'Optional source filter.',
        },
        app: { type: 'string', description: 'Optional active app substring filter.' },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Default 20, max 100.' },
        offset: { type: 'number', minimum: 0, description: 'Pagination offset.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'timeline',
    description:
      'List captured chunks in chronological order for a time range. Results include both local_* and utc_* timestamps; use local_* when answering the user.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Required ISO date or epoch-ms lower bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        to: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description:
            "Required ISO date or epoch-ms upper bound. ISO strings without a timezone are interpreted in the user's local timezone.",
        },
        source: {
          type: 'string',
          enum: ['screen', 'mic', 'system'],
          description: 'Optional source filter.',
        },
        app: { type: 'string', description: 'Optional active app substring filter.' },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Default 20, max 100.' },
        offset: { type: 'number', minimum: 0, description: 'Pagination offset.' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
    description:
      'Fetch one captured chunk by id, including linked transcript segments. Blob paths are opt-in.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Chunk id.' },
        include_blob: {
          type: 'boolean',
          description: 'When true, include local blob_path, mime_type, and bytes.',
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_transcript_segment',
    description:
      'Fetch one transcript segment by id, optionally including its parent chunk summary.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Transcript segment id.' },
        include_chunk: { type: 'boolean', description: 'Default true.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
]

export interface McpServerOptions {
  dbPath?: string
  transport?: 'stdio' | 'http'
  bind?: string
  port?: number
}

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: unknown
  isError?: boolean
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '')
    throw new ReadStoreError(`${key} is required`)
  return value
}

function validateRange(from: number | undefined, to: number | undefined): void {
  if (from !== undefined && to !== undefined && to < from) {
    throw new ReadStoreError('to must be greater than or equal to from')
  }
}

function linesForSearch(
  results: Array<{
    local_time: string
    timezone: string
    source: string
    snippet: string
    id: string
    type: string
  }>,
): string {
  if (results.length === 0) return 'No matching Hyprmnesia memories.'
  return results
    .slice(0, 10)
    .map(
      (r) =>
        `- ${r.local_time} ${r.timezone} ${r.source} ${r.type} ${r.id}: ${r.snippet || '(no text)'}`,
    )
    .join('\n')
}

function linesForTimeline(
  items: Array<{
    local_at: string
    timezone: string
    source: string
    id: string
    text: string
    window: { app: string | null; title: string | null }
  }>,
): string {
  if (items.length === 0) return 'No Hyprmnesia captures in this range.'
  return items
    .slice(0, 12)
    .map((item) => {
      const window = [item.window.app, item.window.title].filter(Boolean).join(' - ')
      return `- ${item.local_at} ${item.timezone} ${item.source} ${item.id}${window ? ` (${window})` : ''}: ${item.text || '(no text)'}`
    })
    .join('\n')
}

async function callTool(dbPath: string, name: string, rawArgs: unknown): Promise<ToolResult> {
  const args = asRecord(rawArgs)
  if (name === 'search') {
    const query = stringArg(args, 'query')
    const from = parseTimestamp(args['from'], 'from')
    const to = parseTimestamp(args['to'], 'to')
    validateRange(from, to)
    const source = normalizeSource(args['source'])
    const results = withReadStore(dbPath, (store) =>
      store.search(query, {
        from,
        to,
        source,
        app: typeof args['app'] === 'string' ? args['app'] : undefined,
        limit: clampLimit(args['limit']),
        offset: clampOffset(args['offset']),
      }),
    )
    return {
      content: [{ type: 'text', text: linesForSearch(results) }],
      structuredContent: { results, count: results.length },
    }
  }

  if (name === 'timeline') {
    const from = parseTimestamp(args['from'], 'from')
    const to = parseTimestamp(args['to'], 'to')
    if (from === undefined || to === undefined) throw new ReadStoreError('from and to are required')
    validateRange(from, to)
    const source = normalizeSource(args['source'])
    const items = withReadStore(dbPath, (store) =>
      store.timeline({
        from,
        to,
        source,
        app: typeof args['app'] === 'string' ? args['app'] : undefined,
        limit: clampLimit(args['limit']),
        offset: clampOffset(args['offset']),
      }),
    )
    return {
      content: [{ type: 'text', text: linesForTimeline(items) }],
      structuredContent: { items, count: items.length },
    }
  }

  if (name === 'recall') {
    const id = stringArg(args, 'id')
    const result = withReadStore(dbPath, (store) =>
      store.recall(id, boolArg(args['include_blob'], false)),
    )
    const text =
      result.found && result.chunk
        ? `Chunk ${id}: ${result.chunk.text || '(no text)'}`
        : `Chunk not found: ${id}`
    return { content: [{ type: 'text', text }], structuredContent: result }
  }

  if (name === 'get_transcript_segment') {
    const id = stringArg(args, 'id')
    const result = withReadStore(dbPath, (store) =>
      store.getTranscriptSegment(id, boolArg(args['include_chunk'], true)),
    )
    const text =
      result.found && result.segment
        ? `Transcript segment ${id}: ${result.segment.text || '(no text)'}`
        : `Transcript segment not found: ${id}`
    return { content: [{ type: 'text', text }], structuredContent: result }
  }

  throw new ReadStoreError(`unknown tool: ${name}`)
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } }
}

function protocolResult(method: string, params: unknown): unknown {
  if (method === 'initialize') {
    const requested = asRecord(params)['protocolVersion']
    return {
      protocolVersion: typeof requested === 'string' ? requested : PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: 'hyprmnesia',
        version: '0.0.1',
      },
      instructions:
        'Hyprmnesia MCP is local and read-only. Use search for text lookup, timeline for time windows, recall for chunk details, and get_transcript_segment for precise transcript segments. Results include UTC and local timestamps; use local_* timestamps when answering the user.',
    }
  }
  if (method === 'tools/list') return { tools: TOOLS }
  if (method === 'resources/list') return { resources: [] }
  if (method === 'prompts/list') return { prompts: [] }
  if (method === 'ping' || method === 'logging/setLevel') return {}
  return undefined
}

async function handleMessage(
  dbPath: string,
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | undefined> {
  const hasId = Object.hasOwn(message, 'id')
  const id = hasId ? (message.id ?? null) : null
  if (!message.method) {
    if (hasId) return failure(id, -32600, 'Invalid Request')
    return undefined
  }

  const staticResult = protocolResult(message.method, message.params)
  if (staticResult !== undefined) return hasId ? success(id, staticResult) : undefined

  if (message.method === 'tools/call') {
    if (!hasId) return undefined
    const params = asRecord(message.params)
    const name = params['name']
    if (typeof name !== 'string') return failure(id, -32602, 'tools/call requires params.name')
    try {
      return success(id, await callTool(dbPath, name, params['arguments']))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return success(id, { content: [{ type: 'text', text: message }], isError: true })
    }
  }

  return hasId ? failure(id, -32601, `Method not found: ${message.method}`) : undefined
}

function isLocalBind(bind: string): boolean {
  return bind === '127.0.0.1' || bind === 'localhost' || bind === '::1' || bind === '[::1]'
}

async function startStdioMcpServer(dbPath: string): Promise<void> {
  console.error(
    `[hyprmnesia:mcp] starting read-only MCP server; transport=stdio; db=${dbPath}; tools=${TOOLS.length}`,
  )

  let rpc: StdioJsonRpc
  rpc = new StdioJsonRpc((message: JsonRpcRequest) => {
    void handleMessage(dbPath, message).then((response) => {
      if (response) rpc.send(response)
    })
  })

  await rpc.start()
}

async function startHttpMcpServer(dbPath: string, bind: string, port: number): Promise<void> {
  if (!isLocalBind(bind)) {
    throw new Error(`refusing non-local MCP bind ${bind}; auth is not implemented yet`)
  }

  const server = Bun.serve({
    hostname: bind,
    port,
    async fetch(req) {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({ ok: true, name: 'hyprmnesia', transport: 'http' })
      }
      if (req.method !== 'POST' || url.pathname !== '/mcp') {
        return new Response('not found', { status: 404 })
      }
      let body: unknown
      try {
        body = await req.json()
      } catch (err) {
        return Response.json(failure(null, -32700, 'Parse error', String(err)), { status: 400 })
      }
      const batch = Array.isArray(body)
      const messages = (batch ? body : [body]) as JsonRpcRequest[]
      const responses = (
        await Promise.all(messages.map((message) => handleMessage(dbPath, message)))
      ).filter((response): response is JsonRpcResponse => response !== undefined)
      if (responses.length === 0) return new Response(null, { status: 202 })
      return Response.json(batch ? responses : responses[0], {
        headers: { 'MCP-Protocol-Version': PROTOCOL_VERSION },
      })
    },
  })
  console.error(
    `[hyprmnesia:mcp] starting read-only MCP server; transport=http; url=http://${bind}:${server.port}/mcp; db=${dbPath}; tools=${TOOLS.length}`,
  )

  await new Promise<void>((resolve) => {
    const stop = () => {
      server.stop(true)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

export async function startMcpServer(options: McpServerOptions = {}): Promise<void> {
  const dbPath = expandHome(options.dbPath ?? defaultDbPath())
  const transport = options.transport ?? 'stdio'
  const bind = options.bind ?? '127.0.0.1'
  const port = options.port ?? 37373

  if (transport === 'stdio') {
    await startStdioMcpServer(dbPath)
    return
  }
  if (transport === 'http') {
    await startHttpMcpServer(dbPath, bind, port)
    return
  }

  throw new Error(`unsupported MCP transport: ${String(transport)}`)
}
