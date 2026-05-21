import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

type SourceFilter = 'screen' | 'mic' | 'system'

interface TimeRange {
  from?: number
  to?: number
}

export interface QueryFilters extends TimeRange {
  source?: SourceFilter
  app?: string
  limit?: number
  offset?: number
}

interface WindowPayload {
  app: string | null
  title: string | null
  url: string | null
  pid: number | null
}

export interface SearchResult {
  id: string
  type: 'chunk' | 'transcript_segment'
  source: 'screen' | 'mic' | 'system'
  time: number
  timezone: string
  local_time: string
  utc_time: string
  iso_time: string
  end_time?: number | null
  local_end_time?: string | null
  utc_end_time?: string | null
  iso_end_time?: string | null
  snippet: string
  score: number
  chunk_id: string
  window: WindowPayload
}

export interface TimelineItem {
  id: string
  kind: 'screenshot' | 'audio_mic' | 'audio_system'
  source: 'screen' | 'mic' | 'system'
  at: number
  timezone: string
  local_at: string
  utc_at: string
  iso_at: string
  start_at: number | null
  local_start_at: string | null
  utc_start_at: string | null
  iso_start_at: string | null
  end_at: number | null
  local_end_at: string | null
  utc_end_at: string | null
  iso_end_at: string | null
  duration_ms: number | null
  text: string
  text_len: number
  has_blob: boolean
  bytes: number
  window: WindowPayload
}

interface TranscriptSegment {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  start_at: number
  timezone: string
  local_start_at: string
  utc_start_at: string
  iso_start_at: string
  end_at: number
  local_end_at: string
  utc_end_at: string
  iso_end_at: string
  text: string
  engine: string
  transcribe_ms: number
}

export interface RecallResult {
  found: boolean
  chunk?: TimelineItem & {
    blob_path?: string
    mime_type?: string
    ocr_engine: string | null
    audio_engine: string | null
    audio_device: string | null
    audio_sample_rate: number | null
    audio_chunk_ms: number | null
    audio_rms_db: number | null
    audio_peak_db: number | null
    segments: TranscriptSegment[]
  }
}

export interface SegmentResult {
  found: boolean
  segment?: TranscriptSegment & { chunk?: TimelineItem }
}

interface ChunkRow {
  id: string
  kind: 'screenshot' | 'audio_mic' | 'audio_system'
  at: number
  start_at: number | null
  end_at: number | null
  blob: string
  bytes: number
  text: string
  capture_ms: number
  window_app: string | null
  window_title: string | null
  window_url: string | null
  window_pid: number | null
  ocr_engine: string | null
  audio_engine: string | null
  audio_device: string | null
  audio_sample_rate: number | null
  audio_chunk_ms: number | null
  audio_rms_db: number | null
  audio_peak_db: number | null
}

interface SegmentRow {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  start_at: number
  end_at: number
  text: string
  engine: string
  transcribe_ms: number
}

interface SearchChunkRow extends ChunkRow {
  snippet: string
  score: number
}

interface SearchSegmentRow extends SegmentRow {
  snippet: string
  score: number
  window_app: string | null
  window_title: string | null
  window_url: string | null
  window_pid: number | null
}

export class ReadStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReadStoreError'
  }
}

export function clampLimit(value: unknown, fallback = 20): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(100, Math.trunc(n)))
}

export function clampOffset(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.trunc(n))
}

export function parseTimestamp(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ReadStoreError(`${name} must be a finite epoch-ms number or ISO date`)
    return Math.trunc(value)
  }
  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && value.trim() !== '') return Math.trunc(asNumber)
    const parsed = Date.parse(value)
    if (!Number.isFinite(parsed))
      throw new ReadStoreError(`${name} must be an epoch-ms number or ISO date`)
    return parsed
  }
  throw new ReadStoreError(`${name} must be an epoch-ms number or ISO date`)
}

export function normalizeSource(value: unknown): SourceFilter | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'screen' || value === 'screenshot') return 'screen'
  if (value === 'mic' || value === 'audio_mic') return 'mic'
  if (value === 'system' || value === 'audio_system') return 'system'
  throw new ReadStoreError('source must be one of: screen, mic, system')
}

function buildFtsQuery(query: unknown): string {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new ReadStoreError('query is required')
  }
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? []
  if (tokens.length === 0)
    throw new ReadStoreError('query must contain at least one searchable token')
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ')
}

const LOCAL_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local'

function iso(ms: number | null | undefined): string | null {
  return typeof ms === 'number' ? new Date(ms).toISOString() : null
}

function localIso(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number') return null
  const d = new Date(ms)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

function chunkSource(kind: ChunkRow['kind']): 'screen' | 'mic' | 'system' {
  if (kind === 'screenshot') return 'screen'
  if (kind === 'audio_mic') return 'mic'
  return 'system'
}

function kindForSource(source: SourceFilter | undefined): ChunkRow['kind'] | undefined {
  if (source === 'screen') return 'screenshot'
  if (source === 'mic') return 'audio_mic'
  if (source === 'system') return 'audio_system'
  return undefined
}

function windowFromRow(
  row: Pick<ChunkRow, 'window_app' | 'window_title' | 'window_url' | 'window_pid'>,
): WindowPayload {
  return {
    app: row.window_app,
    title: row.window_title,
    url: row.window_url,
    pid: row.window_pid,
  }
}

function excerpt(text: string | null | undefined, max = 280): string {
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 3).trimEnd()}...`
}

function mimeForKind(kind: ChunkRow['kind'], blob: string): string {
  const lower = blob.toLowerCase()
  if (kind === 'screenshot')
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  return 'audio/wav'
}

function toTimelineItem(row: ChunkRow): TimelineItem {
  const start = row.start_at ?? row.at
  const end = row.end_at
  return {
    id: row.id,
    kind: row.kind,
    source: chunkSource(row.kind),
    at: row.at,
    timezone: LOCAL_TIMEZONE,
    local_at: localIso(row.at)!,
    utc_at: iso(row.at)!,
    iso_at: iso(row.at)!,
    start_at: row.start_at,
    local_start_at: localIso(row.start_at),
    utc_start_at: iso(row.start_at),
    iso_start_at: iso(row.start_at),
    end_at: end,
    local_end_at: localIso(end),
    utc_end_at: iso(end),
    iso_end_at: iso(end),
    duration_ms: typeof end === 'number' ? Math.max(0, end - start) : null,
    text: excerpt(row.text),
    text_len: row.text?.length ?? 0,
    has_blob: row.bytes > 0 && existsSync(row.blob),
    bytes: row.bytes,
    window: windowFromRow(row),
  }
}

function toSegment(row: SegmentRow): TranscriptSegment {
  return {
    id: row.id,
    chunk_id: row.chunk_id,
    source: row.source,
    start_at: row.start_at,
    timezone: LOCAL_TIMEZONE,
    local_start_at: localIso(row.start_at)!,
    utc_start_at: iso(row.start_at)!,
    iso_start_at: iso(row.start_at)!,
    end_at: row.end_at,
    local_end_at: localIso(row.end_at)!,
    utc_end_at: iso(row.end_at)!,
    iso_end_at: iso(row.end_at)!,
    text: row.text,
    engine: row.engine,
    transcribe_ms: row.transcribe_ms,
  }
}

export class HyprmnesiaReadStore {
  private db: Database

  constructor(readonly dbPath: string) {
    if (!existsSync(dbPath)) {
      throw new ReadStoreError(`index database not found at ${dbPath}`)
    }
    try {
      this.db = new Database(dbPath, { readonly: true, create: false })
      this.db.run('PRAGMA query_only = ON')
      this.db.run('PRAGMA busy_timeout = 2000')
      const version =
        this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
      if (version < 2) {
        throw new ReadStoreError(`index database schema is v${version}; MCP requires v2 or newer`)
      }
    } catch (err) {
      if (err instanceof ReadStoreError) throw err
      throw new ReadStoreError(`failed to open read-only index database: ${String(err)}`)
    }
  }

  close(): void {
    this.db.close()
  }

  search(query: string, filters: QueryFilters): SearchResult[] {
    const fts = buildFtsQuery(query)
    const limit = clampLimit(filters.limit)
    const offset = clampOffset(filters.offset)
    const innerLimit = limit + offset
    const source = normalizeSource(filters.source)
    const params = {
      $query: fts,
      $from: filters.from ?? null,
      $to: filters.to ?? null,
      $kind: kindForSource(source) ?? null,
      $segment_source: source === 'screen' ? '__none__' : (source ?? null),
      $app: filters.app ? `%${filters.app}%` : null,
      $limit: innerLimit,
      $offset: 0,
    }

    const chunks =
      source === 'mic' || source === 'system'
        ? []
        : this.db
            .query<SearchChunkRow, typeof params>(
              `
              SELECT c.*,
                     snippet(chunks_fts, 0, '', '', '...', 24) AS snippet,
                     bm25(chunks_fts) AS score
              FROM chunks_fts
              JOIN chunks c ON c.rowid = chunks_fts.rowid
              WHERE chunks_fts MATCH $query
                AND ($from IS NULL OR c.at >= $from)
                AND ($to IS NULL OR c.at <= $to)
                AND ($kind IS NULL OR c.kind = $kind)
                AND ($app IS NULL OR c.window_app LIKE $app)
              ORDER BY score
              LIMIT $limit OFFSET $offset
            `,
            )
            .all(params)

    const segments =
      source === 'screen'
        ? []
        : this.db
            .query<SearchSegmentRow, typeof params>(
              `
              SELECT s.*,
                     c.window_app, c.window_title, c.window_url, c.window_pid,
                     snippet(transcript_segments_fts, 0, '', '', '...', 24) AS snippet,
                     bm25(transcript_segments_fts) AS score
              FROM transcript_segments_fts
              JOIN transcript_segments s ON s.rowid = transcript_segments_fts.rowid
              JOIN chunks c ON c.id = s.chunk_id
              WHERE transcript_segments_fts MATCH $query
                AND ($from IS NULL OR s.start_at >= $from)
                AND ($to IS NULL OR s.start_at <= $to)
                AND ($segment_source IS NULL OR s.source = $segment_source)
                AND ($app IS NULL OR c.window_app LIKE $app)
              ORDER BY score
              LIMIT $limit OFFSET $offset
            `,
            )
            .all(params)

    const out: SearchResult[] = [
      ...segments.map((row) => ({
        id: row.id,
        type: 'transcript_segment' as const,
        source: row.source,
        time: row.start_at,
        timezone: LOCAL_TIMEZONE,
        local_time: localIso(row.start_at)!,
        utc_time: iso(row.start_at)!,
        iso_time: iso(row.start_at)!,
        end_time: row.end_at,
        local_end_time: localIso(row.end_at),
        utc_end_time: iso(row.end_at),
        iso_end_time: iso(row.end_at),
        snippet: excerpt(row.snippet || row.text),
        score: row.score,
        chunk_id: row.chunk_id,
        window: windowFromRow(row),
      })),
      ...chunks.map((row) => ({
        id: row.id,
        type: 'chunk' as const,
        source: chunkSource(row.kind),
        time: row.at,
        timezone: LOCAL_TIMEZONE,
        local_time: localIso(row.at)!,
        utc_time: iso(row.at)!,
        iso_time: iso(row.at)!,
        end_time: row.end_at,
        local_end_time: localIso(row.end_at),
        utc_end_time: iso(row.end_at),
        iso_end_time: iso(row.end_at),
        snippet: excerpt(row.snippet || row.text),
        score: row.score,
        chunk_id: row.id,
        window: windowFromRow(row),
      })),
    ]

    return out.sort((a, b) => a.score - b.score || b.time - a.time).slice(offset, offset + limit)
  }

  timeline(filters: QueryFilters & { from: number; to: number }): TimelineItem[] {
    const limit = clampLimit(filters.limit)
    const offset = clampOffset(filters.offset)
    const source = normalizeSource(filters.source)
    const params = {
      $from: filters.from,
      $to: filters.to,
      $kind: kindForSource(source) ?? null,
      $app: filters.app ? `%${filters.app}%` : null,
      $limit: limit,
      $offset: offset,
    }
    const rows = this.db
      .query<ChunkRow, typeof params>(
        `
        SELECT *
        FROM chunks
        WHERE at >= $from
          AND at <= $to
          AND ($kind IS NULL OR kind = $kind)
          AND ($app IS NULL OR window_app LIKE $app)
        ORDER BY at ASC
        LIMIT $limit OFFSET $offset
      `,
      )
      .all(params)
    return rows.map(toTimelineItem)
  }

  recall(id: string, includeBlob: boolean): RecallResult {
    const row = this.db.query<ChunkRow, [string]>('SELECT * FROM chunks WHERE id = ?').get(id)
    if (!row) return { found: false }
    const segments = this.db
      .query<SegmentRow, [string]>(
        `
        SELECT *
        FROM transcript_segments
        WHERE chunk_id = ?
        ORDER BY start_at ASC
      `,
      )
      .all(id)
      .map(toSegment)
    const chunk = {
      ...toTimelineItem(row),
      text: row.text ?? '',
      ocr_engine: row.ocr_engine,
      audio_engine: row.audio_engine,
      audio_device: row.audio_device,
      audio_sample_rate: row.audio_sample_rate,
      audio_chunk_ms: row.audio_chunk_ms,
      audio_rms_db: row.audio_rms_db,
      audio_peak_db: row.audio_peak_db,
      segments,
      ...(includeBlob ? { blob_path: row.blob, mime_type: mimeForKind(row.kind, row.blob) } : {}),
    }
    return { found: true, chunk }
  }

  getTranscriptSegment(id: string, includeChunk: boolean): SegmentResult {
    const row = this.db
      .query<SegmentRow, [string]>('SELECT * FROM transcript_segments WHERE id = ?')
      .get(id)
    if (!row) return { found: false }
    const segment = toSegment(row)
    if (!includeChunk) return { found: true, segment }
    const chunk = this.db
      .query<ChunkRow, [string]>('SELECT * FROM chunks WHERE id = ?')
      .get(row.chunk_id)
    return {
      found: true,
      segment: { ...segment, ...(chunk ? { chunk: toTimelineItem(chunk) } : {}) },
    }
  }
}

export function withReadStore<T>(dbPath: string, fn: (store: HyprmnesiaReadStore) => T): T {
  const store = new HyprmnesiaReadStore(dbPath)
  try {
    return fn(store)
  } finally {
    store.close()
  }
}
