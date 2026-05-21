import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { buildActivityGroups } from './activity'
import {
  buildFtsQuery,
  clampLimit,
  clampOffset,
  normalizeSource,
  ReadStoreError,
} from './filters'
import {
  chunkSource,
  excerpt,
  iso,
  kindForSource,
  LOCAL_TIMEZONE,
  localIso,
  mimeForKind,
  toSegment,
  toTimelineItem,
  windowFromRow,
} from './format'
import type {
  ActivityGroup,
  ChunkRow,
  QueryFilters,
  RecallResult,
  RecentActivityFilters,
  SearchChunkRow,
  SearchResult,
  SearchSegmentRow,
  SegmentResult,
  SegmentRow,
  TimelineItem,
} from './types'

export {
  clampLimit,
  clampOffset,
  normalizeSource,
  normalizeSources,
  parseTimestamp,
  ReadStoreError,
} from './filters'
export type {
  ActivityGroup,
  QueryFilters,
  RecallResult,
  RecentActivityFilters,
  SearchResult,
  SegmentResult,
  TimelineItem,
} from './types'

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

    const groups = buildActivityGroups(rows)
    return groups.slice(Math.max(0, groups.length - limit))
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
