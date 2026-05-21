import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'

type SourceFilter = 'screen' | 'mic' | 'system'
type AudioState =
  | 'recording'
  | 'transcribed'
  | 'pending'
  | 'quiet_no_transcript'
  | 'captured_no_transcript'

interface TimeRange {
  from?: number
  to?: number
}

export interface QueryFilters extends TimeRange {
  source?: SourceFilter
  app?: string
  limit?: number
  offset?: number
  includeEmpty?: boolean
}

export interface RecentActivityFilters {
  from: number
  to: number
  sources: SourceFilter[]
  app?: string
  limit?: number
  includeEmpty?: boolean
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
  segment_count: number
  audio?: AudioDiagnostics
}

interface AudioDiagnostics {
  rms_db: number | null
  peak_db: number | null
  engine: string | null
  device: string | null
  segment_count: number
  state: AudioState
}

export interface ActivityGroup {
  id: string
  start_at: number
  timezone: string
  local_start_at: string
  utc_start_at: string
  iso_start_at: string
  end_at: number
  local_end_at: string
  utc_end_at: string
  iso_end_at: string
  duration_ms: number
  sources: Array<'screen' | 'mic' | 'system'>
  window: WindowPayload
  url: string | null
  url_candidate: string | null
  url_source: 'native' | 'ocr_candidate' | 'none'
  url_confidence: 'high' | 'low' | 'none'
  text_preview: string
  chunk_ids: string[]
  chunk_ids_by_source: Record<'screen' | 'mic' | 'system', string[]>
  counts: {
    chunks: number
    screen: number
    mic: number
    system: number
    transcript_segments: number
  }
  audio: {
    mic?: AudioGroupDiagnostics
    system?: AudioGroupDiagnostics
  }
}

interface AudioGroupDiagnostics {
  segment_count: number
  states: AudioState[]
  rms_db_min: number | null
  rms_db_max: number | null
  peak_db_max: number | null
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
  segment_count?: number
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

export function normalizeSources(value: unknown): SourceFilter[] {
  if (value === undefined || value === null || value === '') return ['screen', 'mic', 'system']
  if (!Array.isArray(value)) throw new ReadStoreError('sources must be an array')
  const out: SourceFilter[] = []
  for (const item of value) {
    const source = normalizeSource(item)
    if (source && !out.includes(source)) out.push(source)
  }
  return out.length > 0 ? out : ['screen', 'mic', 'system']
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

function textPresent(text: string | null | undefined): boolean {
  return (text ?? '').trim().length > 0
}

function audioRange(values: Array<number | null | undefined>): {
  min: number | null
  max: number | null
} {
  const nums = values.filter((value): value is number => typeof value === 'number')
  if (nums.length === 0) return { min: null, max: null }
  return { min: Math.min(...nums), max: Math.max(...nums) }
}

function mimeForKind(kind: ChunkRow['kind'], blob: string): string {
  const lower = blob.toLowerCase()
  if (kind === 'screenshot')
    return lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  return 'audio/wav'
}

function audioState(row: ChunkRow, segmentCount: number, now = Date.now()): AudioState {
  if (row.kind === 'screenshot') return 'captured_no_transcript'
  if (segmentCount > 0 || textPresent(row.text)) return 'transcribed'
  if (!row.end_at || row.bytes <= 0) return 'recording'
  const endedAt = row.end_at ?? row.at
  if (row.audio_engine === 'pending' && now - endedAt < 120_000) return 'pending'
  if (
    (typeof row.audio_peak_db === 'number' && row.audio_peak_db <= -75) ||
    (typeof row.audio_rms_db === 'number' && row.audio_rms_db <= -85)
  ) {
    return 'quiet_no_transcript'
  }
  return 'captured_no_transcript'
}

function toTimelineItem(row: ChunkRow, segmentCount = row.segment_count ?? 0): TimelineItem {
  const start = row.start_at ?? row.at
  const end = row.end_at
  const item: TimelineItem = {
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
    segment_count: segmentCount,
  }
  if (row.kind !== 'screenshot') {
    item.audio = {
      rms_db: row.audio_rms_db,
      peak_db: row.audio_peak_db,
      engine: row.audio_engine,
      device: row.audio_device,
      segment_count: segmentCount,
      state: audioState(row, segmentCount),
    }
  }
  return item
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

interface ActivityAccumulator {
  id: string
  key: string
  start_at: number
  end_at: number
  window: WindowPayload
  chunks: TimelineItem[]
  fullTextParts: string[]
  sources: Set<'screen' | 'mic' | 'system'>
  chunk_ids_by_source: Record<'screen' | 'mic' | 'system', string[]>
  transcriptSegments: number
}

function rowStart(row: ChunkRow): number {
  return row.start_at ?? row.at
}

function rowEnd(row: ChunkRow): number {
  return row.end_at ?? row.at
}

function hasWindow(row: ChunkRow): boolean {
  return Boolean(row.window_url || row.window_app || row.window_title)
}

function windowKey(row: ChunkRow): string | undefined {
  if (row.window_url) return `url:${row.window_url}`
  if (row.window_app || row.window_title) return `window:${row.window_app ?? ''}|${row.window_title ?? ''}`
  return undefined
}

function sourceOrder(source: 'screen' | 'mic' | 'system'): number {
  if (source === 'screen') return 0
  if (source === 'system') return 1
  return 2
}

function extractUrlCandidate(text: string): string | null {
  const match = text.match(
    /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s<>"']+)/i,
  )
  if (!match?.[0]) return null
  const candidate = match[0].replace(/[),.;:!?]+$/g, '')
  return candidate.includes('.') ? candidate : null
}

function createActivity(row: ChunkRow, key: string): ActivityAccumulator {
  const item = toTimelineItem(row)
  return {
    id: `activity:${row.id}`,
    key,
    start_at: rowStart(row),
    end_at: rowEnd(row),
    window: item.window,
    chunks: [],
    fullTextParts: [],
    sources: new Set(),
    chunk_ids_by_source: { screen: [], mic: [], system: [] },
    transcriptSegments: 0,
  }
}

function addRowToActivity(group: ActivityAccumulator, row: ChunkRow): void {
  const item = toTimelineItem(row)
  const source = item.source
  group.start_at = Math.min(group.start_at, rowStart(row))
  group.end_at = Math.max(group.end_at, rowEnd(row))
  group.chunks.push(item)
  group.sources.add(source)
  group.chunk_ids_by_source[source].push(row.id)
  group.transcriptSegments += item.segment_count
  if (textPresent(row.text)) group.fullTextParts.push(row.text)
  if (!group.window.url && item.window.url) group.window.url = item.window.url
  if (!group.window.app && item.window.app) group.window.app = item.window.app
  if (!group.window.title && item.window.title) group.window.title = item.window.title
  if (!group.window.pid && item.window.pid) group.window.pid = item.window.pid
}

function canAppendToWindowGroup(group: ActivityAccumulator, row: ChunkRow): boolean {
  const key = windowKey(row)
  return Boolean(key && group.key === key && rowStart(row) - group.end_at <= 30_000)
}

function overlaps(group: ActivityAccumulator, row: ChunkRow): boolean {
  return rowStart(row) <= group.end_at && rowEnd(row) >= group.start_at
}

function findRecentGroup(
  groups: ActivityAccumulator[],
  predicate: (group: ActivityAccumulator) => boolean,
): ActivityAccumulator | undefined {
  for (let i = groups.length - 1; i >= 0; i--) {
    const group = groups[i]
    if (group && predicate(group)) return group
  }
  return undefined
}

function audioSummary(
  items: TimelineItem[],
  source: 'mic' | 'system',
): AudioGroupDiagnostics | undefined {
  const audio = items.filter((item) => item.source === source && item.audio)
  if (audio.length === 0) return undefined
  const rms = audioRange(audio.map((item) => item.audio?.rms_db))
  const peak = audioRange(audio.map((item) => item.audio?.peak_db))
  const states = Array.from(new Set(audio.map((item) => item.audio!.state)))
  return {
    segment_count: audio.reduce((sum, item) => sum + (item.audio?.segment_count ?? 0), 0),
    states,
    rms_db_min: rms.min,
    rms_db_max: rms.max,
    peak_db_max: peak.max,
  }
}

function toActivityGroup(group: ActivityAccumulator): ActivityGroup {
  const sortedChunks = [...group.chunks].sort((a, b) => a.at - b.at || sourceOrder(a.source) - sourceOrder(b.source))
  const nativeUrl = group.window.url
  const text = group.fullTextParts.join(' ')
  const candidate = nativeUrl ? null : extractUrlCandidate(text)
  return {
    id: group.id,
    start_at: group.start_at,
    timezone: LOCAL_TIMEZONE,
    local_start_at: localIso(group.start_at)!,
    utc_start_at: iso(group.start_at)!,
    iso_start_at: iso(group.start_at)!,
    end_at: group.end_at,
    local_end_at: localIso(group.end_at)!,
    utc_end_at: iso(group.end_at)!,
    iso_end_at: iso(group.end_at)!,
    duration_ms: Math.max(0, group.end_at - group.start_at),
    sources: (['screen', 'system', 'mic'] as const).filter((source) => group.sources.has(source)),
    window: group.window,
    url: nativeUrl,
    url_candidate: candidate,
    url_source: nativeUrl ? 'native' : candidate ? 'ocr_candidate' : 'none',
    url_confidence: nativeUrl ? 'high' : candidate ? 'low' : 'none',
    text_preview: excerpt(text, 600),
    chunk_ids: sortedChunks.map((item) => item.id),
    chunk_ids_by_source: group.chunk_ids_by_source,
    counts: {
      chunks: sortedChunks.length,
      screen: group.chunk_ids_by_source.screen.length,
      mic: group.chunk_ids_by_source.mic.length,
      system: group.chunk_ids_by_source.system.length,
      transcript_segments: group.transcriptSegments,
    },
    audio: {
      mic: audioSummary(sortedChunks, 'mic'),
      system: audioSummary(sortedChunks, 'system'),
    },
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
      $include_empty: filters.includeEmpty ? 1 : 0,
      $limit: limit,
      $offset: offset,
    }
    const rows = this.db
      .query<ChunkRow, typeof params>(
        `
        SELECT c.*,
               (SELECT COUNT(*) FROM transcript_segments s WHERE s.chunk_id = c.id) AS segment_count
        FROM chunks c
        WHERE c.at >= $from
          AND c.at <= $to
          AND ($kind IS NULL OR c.kind = $kind)
          AND ($app IS NULL OR c.window_app LIKE $app)
          AND (
            $include_empty = 1
            OR COALESCE(c.text, '') <> ''
            OR EXISTS (SELECT 1 FROM transcript_segments sx WHERE sx.chunk_id = c.id)
          )
        ORDER BY at ASC
        LIMIT $limit OFFSET $offset
      `,
      )
      .all(params)
    return rows.map(toTimelineItem)
  }

  recentActivity(filters: RecentActivityFilters): ActivityGroup[] {
    const limit = clampLimit(filters.limit, 50)
    const kinds = new Set(filters.sources.map(kindForSource).filter(Boolean))
    const rawLimit = Math.min(500, Math.max(100, limit * 12))
    const params = {
      $from: filters.from,
      $to: filters.to,
      $include_screen: kinds.has('screenshot') ? 1 : 0,
      $include_mic: kinds.has('audio_mic') ? 1 : 0,
      $include_system: kinds.has('audio_system') ? 1 : 0,
      $app: filters.app ? `%${filters.app}%` : null,
      $include_empty: filters.includeEmpty ? 1 : 0,
      $limit: rawLimit,
    }
    const rows = this.db
      .query<ChunkRow, typeof params>(
        `
        SELECT c.*,
               (SELECT COUNT(*) FROM transcript_segments s WHERE s.chunk_id = c.id) AS segment_count
        FROM chunks c
        WHERE c.at >= $from
          AND c.at <= $to
          AND (
            ($include_screen = 1 AND c.kind = 'screenshot')
            OR ($include_mic = 1 AND c.kind = 'audio_mic')
            OR ($include_system = 1 AND c.kind = 'audio_system')
          )
          AND ($app IS NULL OR c.window_app LIKE $app)
          AND (
            $include_empty = 1
            OR COALESCE(c.text, '') <> ''
            OR EXISTS (SELECT 1 FROM transcript_segments sx WHERE sx.chunk_id = c.id)
          )
        ORDER BY c.at DESC
        LIMIT $limit
      `,
      )
      .all(params)
      .sort((a, b) => a.at - b.at)

    const groups: ActivityAccumulator[] = []
    const unwindowedAudio: ChunkRow[] = []

    for (const row of rows) {
      const key = windowKey(row)
      const isAudio = row.kind !== 'screenshot'
      if (!key && isAudio && !hasWindow(row)) {
        unwindowedAudio.push(row)
        continue
      }
      const effectiveKey = key ?? `source:${chunkSource(row.kind)}`
      let group = findRecentGroup(groups, (candidate) => canAppendToWindowGroup(candidate, row))
      if (!group) {
        group = createActivity(row, effectiveKey)
        groups.push(group)
      }
      addRowToActivity(group, row)
    }

    for (const row of unwindowedAudio) {
      let group = findRecentGroup(groups, (candidate) => candidate.sources.has('screen') && overlaps(candidate, row))
      if (!group) {
        const key = `audio:${chunkSource(row.kind)}`
        group = findRecentGroup(
          groups,
          (candidate) => candidate.key === key && rowStart(row) - candidate.end_at <= 30_000,
        )
      }
      if (!group) {
        group = createActivity(row, `audio:${chunkSource(row.kind)}`)
        groups.push(group)
      }
      addRowToActivity(group, row)
    }

    const ordered = groups
      .sort((a, b) => a.start_at - b.start_at)
      .map(toActivityGroup)
    return ordered.slice(Math.max(0, ordered.length - limit))
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
      ...toTimelineItem(row, segments.length),
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
