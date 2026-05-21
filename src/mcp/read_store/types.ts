export type SourceFilter = 'screen' | 'mic' | 'system'

export type AudioState =
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

export interface WindowPayload {
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

export interface AudioGroupDiagnostics {
  segment_count: number
  states: AudioState[]
  rms_db_min: number | null
  rms_db_max: number | null
  peak_db_max: number | null
}

export interface TranscriptSegment {
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

export interface ChunkRow {
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

export interface SegmentRow {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  start_at: number
  end_at: number
  text: string
  engine: string
  transcribe_ms: number
}

export interface SearchChunkRow extends ChunkRow {
  snippet: string
  score: number
}

export interface SearchSegmentRow extends SegmentRow {
  snippet: string
  score: number
  window_app: string | null
  window_title: string | null
  window_url: string | null
  window_pid: number | null
}
