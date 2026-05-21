// SQLite + FTS5 index for every captured chunk (screenshots, mic audio,
// system audio). One row per chunk, with an external-content FTS5 mirror over
// `text` + the window context columns. Triggers keep the two in sync.
//
// The DB lives at ~/.hyprmnesia/index.db. Blobs continue to live under
// storage.path; this index just holds metadata + searchable text.

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WindowContext } from '../core/events'

type ChunkKind = 'screenshot' | 'audio_mic' | 'audio_system'

interface ChunkRow {
  id: string
  kind: ChunkKind
  at: number
  start_at?: number
  end_at?: number
  blob: string
  bytes: number
  text: string
  capture_ms: number
  window?: WindowContext
  ocr?: { engine: string }
  audio?: {
    engine: string
    device: string
    sample_rate: number
    chunk_ms: number
    rms_db?: number
    peak_db?: number
  }
}

interface TranscriptSegmentRow {
  id: string
  chunk_id: string
  source: 'mic' | 'system'
  start_at: number
  end_at: number
  text: string
  engine: string
  transcribe_ms: number
}

export interface ChunkStore {
  insert(row: ChunkRow): void
  finalizeAudioChunk(
    id: string,
    fields: {
      bytes: number
      capture_ms: number
      end_at: number
      rms_db?: number
      peak_db?: number
    },
  ): void
  insertTranscriptSegment(row: TranscriptSegmentRow): void
  // Updates text and (optionally) audio_engine in a single UPDATE so the FTS
  // trigger only re-indexes once. Called once per audio chunk today; designed
  // to also tolerate repeated calls per id for future live transcription.
  updateText(id: string, text: string, audioEngine?: string): void
  close(): void
}

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS chunks (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  at                INTEGER NOT NULL,
  blob              TEXT NOT NULL,
  bytes             INTEGER NOT NULL,
  text              TEXT NOT NULL DEFAULT '',
  capture_ms        INTEGER NOT NULL,
  window_app        TEXT,
  window_title      TEXT,
  window_url        TEXT,
  window_pid        INTEGER,
  ocr_engine        TEXT,
  audio_engine      TEXT,
  audio_device      TEXT,
  audio_sample_rate INTEGER,
  audio_chunk_ms    INTEGER,
  audio_rms_db      REAL,
  audio_peak_db     REAL
);

CREATE INDEX IF NOT EXISTS chunks_at_idx      ON chunks(at);
CREATE INDEX IF NOT EXISTS chunks_kind_at_idx ON chunks(kind, at);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, window_app, window_title, window_url,
  content='chunks', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

-- chunks_au re-indexes on every UPDATE, including ones that touch only
-- non-FTS columns (audio_engine). Tolerable while updateText is the only
-- updater and writes text + audio_engine together; revisit with a WHEN
-- clause if other narrow UPDATEs appear.
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, window_app, window_title, window_url)
  VALUES (new.rowid, new.text, new.window_app, new.window_title, new.window_url);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, window_app, window_title, window_url)
  VALUES('delete', old.rowid, old.text, old.window_app, old.window_title, old.window_url);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, window_app, window_title, window_url)
  VALUES('delete', old.rowid, old.text, old.window_app, old.window_title, old.window_url);
  INSERT INTO chunks_fts(rowid, text, window_app, window_title, window_url)
  VALUES (new.rowid, new.text, new.window_app, new.window_title, new.window_url);
END;
`

const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS transcript_segments (
  id            TEXT PRIMARY KEY,
  chunk_id      TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  start_at      INTEGER NOT NULL,
  end_at        INTEGER NOT NULL,
  text          TEXT NOT NULL,
  engine        TEXT NOT NULL,
  transcribe_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS transcript_segments_chunk_idx ON transcript_segments(chunk_id);
CREATE INDEX IF NOT EXISTS transcript_segments_time_idx  ON transcript_segments(start_at, end_at);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_segments_fts USING fts5(
  text,
  content='transcript_segments', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS transcript_segments_ai AFTER INSERT ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_ad AFTER DELETE ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
  VALUES('delete', old.rowid, old.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_segments_au AFTER UPDATE ON transcript_segments BEGIN
  INSERT INTO transcript_segments_fts(transcript_segments_fts, rowid, text)
  VALUES('delete', old.rowid, old.text);
  INSERT INTO transcript_segments_fts(rowid, text)
  VALUES (new.rowid, new.text);
END;
`

function columnExists(db: Database, table: string, column: string): boolean {
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  return rows.some((row) => row.name === column)
}

function migrate(db: Database): void {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  const version = row?.user_version ?? 0
  if (version < 1) {
    db.transaction(() => {
      db.run(SCHEMA_V1)
      db.run('PRAGMA user_version = 1')
    })()
  }
  if (version < 2) {
    db.transaction(() => {
      if (!columnExists(db, 'chunks', 'start_at'))
        db.run('ALTER TABLE chunks ADD COLUMN start_at INTEGER')
      if (!columnExists(db, 'chunks', 'end_at'))
        db.run('ALTER TABLE chunks ADD COLUMN end_at INTEGER')
      db.run(SCHEMA_V2)
      db.run('PRAGMA user_version = 2')
    })()
  }
}

export function openChunkStore(dbPath: string): ChunkStore {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA synchronous = NORMAL')
  db.run('PRAGMA foreign_keys = ON')
  migrate(db)

  const insertStmt = db.prepare(`
    INSERT INTO chunks (
      id, kind, at, blob, bytes, text, capture_ms,
      start_at, end_at,
      window_app, window_title, window_url, window_pid,
      ocr_engine,
      audio_engine, audio_device, audio_sample_rate, audio_chunk_ms,
      audio_rms_db, audio_peak_db
    ) VALUES (
      $id, $kind, $at, $blob, $bytes, $text, $capture_ms,
      $start_at, $end_at,
      $window_app, $window_title, $window_url, $window_pid,
      $ocr_engine,
      $audio_engine, $audio_device, $audio_sample_rate, $audio_chunk_ms,
      $audio_rms_db, $audio_peak_db
    )
  `)

  const updateTextStmt = db.prepare(`
    UPDATE chunks SET text = $text WHERE id = $id
  `)
  const updateTextAndEngineStmt = db.prepare(`
    UPDATE chunks SET text = $text, audio_engine = $audio_engine WHERE id = $id
  `)
  const finalizeAudioChunkStmt = db.prepare(`
    UPDATE chunks
    SET bytes = $bytes,
        capture_ms = $capture_ms,
        end_at = $end_at,
        audio_rms_db = $audio_rms_db,
        audio_peak_db = $audio_peak_db
    WHERE id = $id
  `)
  const insertSegmentStmt = db.prepare(`
    INSERT INTO transcript_segments (
      id, chunk_id, source, start_at, end_at, text, engine, transcribe_ms
    ) VALUES (
      $id, $chunk_id, $source, $start_at, $end_at, $text, $engine, $transcribe_ms
    )
  `)
  const appendChunkTextStmt = db.prepare(`
    UPDATE chunks
    SET text = CASE
          WHEN text IS NULL OR text = '' THEN $text
          ELSE text || ' ' || $text
        END,
        audio_engine = $engine
    WHERE id = $chunk_id
  `)

  return {
    insert(row) {
      insertStmt.run({
        $id: row.id,
        $kind: row.kind,
        $at: row.at,
        $blob: row.blob,
        $bytes: row.bytes,
        $text: row.text,
        $capture_ms: row.capture_ms,
        $start_at: row.start_at ?? null,
        $end_at: row.end_at ?? null,
        $window_app: row.window?.app ?? null,
        $window_title: row.window?.title ?? null,
        $window_url: row.window?.url ?? null,
        $window_pid: row.window?.pid ?? null,
        $ocr_engine: row.ocr?.engine ?? null,
        $audio_engine: row.audio?.engine ?? null,
        $audio_device: row.audio?.device ?? null,
        $audio_sample_rate: row.audio?.sample_rate ?? null,
        $audio_chunk_ms: row.audio?.chunk_ms ?? null,
        $audio_rms_db: row.audio?.rms_db ?? null,
        $audio_peak_db: row.audio?.peak_db ?? null,
      })
    },
    finalizeAudioChunk(id, fields) {
      finalizeAudioChunkStmt.run({
        $id: id,
        $bytes: fields.bytes,
        $capture_ms: fields.capture_ms,
        $end_at: fields.end_at,
        $audio_rms_db: fields.rms_db ?? null,
        $audio_peak_db: fields.peak_db ?? null,
      })
    },
    insertTranscriptSegment(row) {
      db.transaction(() => {
        insertSegmentStmt.run({
          $id: row.id,
          $chunk_id: row.chunk_id,
          $source: row.source,
          $start_at: row.start_at,
          $end_at: row.end_at,
          $text: row.text,
          $engine: row.engine,
          $transcribe_ms: row.transcribe_ms,
        })
        appendChunkTextStmt.run({
          $chunk_id: row.chunk_id,
          $text: row.text,
          $engine: row.engine,
        })
      })()
    },
    updateText(id, text, audioEngine) {
      if (audioEngine !== undefined) {
        updateTextAndEngineStmt.run({ $id: id, $text: text, $audio_engine: audioEngine })
      } else {
        updateTextStmt.run({ $id: id, $text: text })
      }
    },
    close() {
      insertStmt.finalize()
      updateTextStmt.finalize()
      updateTextAndEngineStmt.finalize()
      finalizeAudioChunkStmt.finalize()
      insertSegmentStmt.finalize()
      appendChunkTextStmt.finalize()
      db.close()
    },
  }
}
