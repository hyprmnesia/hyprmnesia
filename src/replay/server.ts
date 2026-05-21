import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { statSync } from 'node:fs'
import type { ReplayBlobRef, ReplayChunk, ReplayManifest } from './store'
import { withReplayStore } from './store'

export interface ReplayServerOptions {
  dbPath?: string
  from?: string
  to?: string
  openBrowser?: boolean
}

function token(): string {
  return randomBytes(24).toString('base64url')
}

function noStoreHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    ...extra,
  }
}

function openUrl(url: string): void {
  const command =
    process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
}

function withBlobUrls(manifest: ReplayManifest, authToken: string): ReplayManifest {
  const addUrl = (chunk: ReplayChunk): ReplayChunk => ({
    ...chunk,
    blob_url: chunk.has_blob ? `/blob/${encodeURIComponent(chunk.id)}?token=${authToken}` : null,
  })
  return {
    ...manifest,
    screenshots: manifest.screenshots.map(addUrl),
    audio: {
      mic: manifest.audio.mic.map(addUrl),
      system: manifest.audio.system.map(addUrl),
    },
    segments: manifest.segments.map((segment) => ({ ...segment })),
  }
}

const REPLAY_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hyprmnesia Replay</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #0b0d10;
        --panel: #151920;
        --line: #2a3442;
        --text: #eef3f8;
        --muted: #93a2b3;
        --accent: #55c7ff;
        --accent-2: #7be495;
        --warn: #f6c35f;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--bg);
        color: var(--text);
      }
      button, select, input { font: inherit; }
      .app {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 340px;
        grid-template-rows: auto minmax(0, 1fr) auto;
        height: 100vh;
      }
      .picker {
        grid-column: 1 / -1;
        display: flex;
        align-items: end;
        gap: 10px;
        flex-wrap: wrap;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        background: #10141a;
      }
      .picker label {
        display: grid;
        gap: 4px;
        color: var(--muted);
        font-size: 12px;
      }
      .picker button {
        color: var(--text);
        background: #102638;
        border: 1px solid var(--accent);
        border-radius: 5px;
        padding: 6px 12px;
      }
      .picker-status {
        color: var(--muted);
        font-size: 12px;
        min-height: 20px;
        align-self: center;
      }
      .stage {
        position: relative;
        min-width: 0;
        min-height: 0;
        display: grid;
        place-items: center;
        background: #050607;
        overflow: hidden;
      }
      .stage img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .empty {
        color: var(--muted);
        border: 1px solid var(--line);
        padding: 18px 22px;
        border-radius: 6px;
      }
      .subtitles {
        position: absolute;
        left: 5%;
        right: 5%;
        bottom: 24px;
        display: grid;
        gap: 6px;
        pointer-events: none;
      }
      .subtitle {
        justify-self: center;
        max-width: 100%;
        padding: 7px 10px;
        border-radius: 5px;
        color: white;
        background: rgba(0, 0, 0, 0.72);
        text-shadow: 0 1px 1px black;
      }
      .subtitle b {
        color: var(--accent);
        margin-right: 6px;
      }
      aside {
        min-width: 0;
        overflow: auto;
        border-left: 1px solid var(--line);
        background: var(--panel);
        padding: 14px;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 650;
      }
      .meta {
        color: var(--muted);
        font-size: 12px;
        margin-bottom: 14px;
      }
      .section {
        border-top: 1px solid var(--line);
        padding-top: 12px;
        margin-top: 12px;
      }
      .kv {
        display: grid;
        grid-template-columns: 78px minmax(0, 1fr);
        gap: 6px 10px;
        margin-top: 8px;
      }
      .kv span:nth-child(odd) { color: var(--muted); }
      .mono {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        word-break: break-all;
      }
      .ocr {
        white-space: pre-wrap;
        color: #dce7f2;
        max-height: 260px;
        overflow: auto;
      }
      .controls {
        grid-column: 1 / -1;
        border-top: 1px solid var(--line);
        background: #10141a;
        padding: 10px 12px;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
      }
      .left, .right {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .play {
        width: 78px;
        border: 1px solid var(--accent);
        color: var(--text);
        background: #102638;
        border-radius: 5px;
        padding: 6px 10px;
      }
      .time {
        min-width: 150px;
        color: var(--muted);
        font-variant-numeric: tabular-nums;
      }
      input[type="range"] {
        width: 100%;
        accent-color: var(--accent);
      }
      label {
        display: inline-flex;
        gap: 5px;
        align-items: center;
        color: var(--muted);
        white-space: nowrap;
      }
      label strong { color: var(--text); font-weight: 600; }
      select, input[type="datetime-local"] {
        color: var(--text);
        background: #0c1016;
        border: 1px solid var(--line);
        border-radius: 5px;
        padding: 5px 8px;
      }
      @media (max-width: 900px) {
        .app {
          grid-template-columns: 1fr;
          grid-template-rows: auto minmax(0, 1fr) 260px auto;
        }
        aside { border-left: 0; border-top: 1px solid var(--line); }
        .controls { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main class="app">
      <section class="picker">
        <label>
          Range
          <select id="preset">
            <option value="last-5">Last 5 min</option>
            <option value="last-15" selected>Last 15 min</option>
            <option value="last-30">Last 30 min</option>
            <option value="last-60">Last hour</option>
            <option value="today">Today</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <label>
          From
          <input id="fromInput" type="datetime-local" step="1" />
        </label>
        <label>
          To
          <input id="toInput" type="datetime-local" step="1" />
        </label>
        <button id="loadRange" type="button">Load Replay</button>
        <span id="pickerStatus" class="picker-status"></span>
      </section>
      <section class="stage">
        <div id="empty" class="empty">Choose a replay range</div>
        <img id="screen" alt="Replay screenshot" hidden />
        <div id="subtitles" class="subtitles"></div>
      </section>
      <aside>
        <h1>Hyprmnesia Replay</h1>
        <div id="rangeMeta" class="meta"></div>
        <div id="contextBlock" class="section">
          <strong>Context</strong>
          <div id="context" class="kv"></div>
        </div>
        <div id="ocrBlock" class="section">
          <strong>OCR</strong>
          <div id="ocr" class="ocr"></div>
        </div>
      </aside>
      <section class="controls">
        <div class="left">
          <button id="play" class="play" type="button">Play</button>
          <span id="time" class="time">00:00 / 00:00</span>
        </div>
        <input id="seek" type="range" min="0" max="0" value="0" step="50" />
        <div class="right">
          <select id="speed" aria-label="Playback speed">
            <option value="0.5">0.5x</option>
            <option value="1" selected>1x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
          <label><input id="system" type="checkbox" checked /> <strong>system</strong></label>
          <label><input id="mic" type="checkbox" /> mic</label>
          <label><input id="subs" type="checkbox" checked /> subtitles</label>
          <label><input id="contextToggle" type="checkbox" checked /> context</label>
          <label><input id="ocrToggle" type="checkbox" checked /> OCR</label>
        </div>
      </section>
    </main>
    <script>
      const TOKEN_KEY = 'hpm-replay-token';
      const urlToken = new URLSearchParams(location.search).get('token');
      if (urlToken) {
        sessionStorage.setItem(TOKEN_KEY, urlToken);
        const cleaned = new URL(location.href);
        cleaned.searchParams.delete('token');
        history.replaceState(null, '', cleaned.pathname + cleaned.search);
      }
      const token = sessionStorage.getItem(TOKEN_KEY) || '';
      const api = (path) => path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
      const els = {
        preset: document.getElementById('preset'),
        fromInput: document.getElementById('fromInput'),
        toInput: document.getElementById('toInput'),
        loadRange: document.getElementById('loadRange'),
        pickerStatus: document.getElementById('pickerStatus'),
        empty: document.getElementById('empty'),
        screen: document.getElementById('screen'),
        subtitles: document.getElementById('subtitles'),
        rangeMeta: document.getElementById('rangeMeta'),
        contextBlock: document.getElementById('contextBlock'),
        context: document.getElementById('context'),
        ocr: document.getElementById('ocr'),
        ocrBlock: document.getElementById('ocrBlock'),
        play: document.getElementById('play'),
        time: document.getElementById('time'),
        seek: document.getElementById('seek'),
        speed: document.getElementById('speed'),
        system: document.getElementById('system'),
        mic: document.getElementById('mic'),
        subs: document.getElementById('subs'),
        contextToggle: document.getElementById('contextToggle'),
        ocrToggle: document.getElementById('ocrToggle'),
      };
      const tracks = {
        system: { id: null, audio: null },
        mic: { id: null, audio: null },
      };
      let manifest;
      let currentMs = 0;
      let playing = false;
      let lastFrame = 0;
      let activeScreenshotId = null;
      let bounds = null;

      function parseTimeParam(value) {
        if (!value) return NaN;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && value.trim() !== '') return numeric;
        return Date.parse(value);
      }

      function toLocalInput(ms) {
        if (!Number.isFinite(ms)) return '';
        const d = new Date(ms);
        const pad = (n) => String(n).padStart(2, '0');
        return d.getFullYear()
          + '-' + pad(d.getMonth() + 1)
          + '-' + pad(d.getDate())
          + 'T' + pad(d.getHours())
          + ':' + pad(d.getMinutes())
          + ':' + pad(d.getSeconds());
      }

      function fromLocalInput(value) {
        const ms = new Date(value).getTime();
        return Number.isFinite(ms) ? ms : NaN;
      }

      function setRangeFields(from, to) {
        els.fromInput.value = toLocalInput(from);
        els.toInput.value = toLocalInput(to);
      }

      function setPickerStatus(message, isError = false) {
        els.pickerStatus.textContent = message;
        els.pickerStatus.style.color = isError ? 'var(--warn)' : 'var(--muted)';
      }

      function applyPreset() {
        const now = Date.now();
        const preset = els.preset.value;
        if (preset === 'custom') return;
        if (preset === 'today') {
          const start = new Date();
          start.setHours(0, 0, 0, 0);
          setRangeFields(start.getTime(), now);
          return;
        }
        const minutes = Number(preset.replace('last-', ''));
        if (Number.isFinite(minutes)) setRangeFields(now - minutes * 60_000, now);
      }

      function fmt(ms) {
        ms = Math.max(0, Math.floor(ms));
        const total = Math.floor(ms / 1000);
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0
          ? String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
          : String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }

      function activeByStart(items, ms) {
        let active = null;
        for (const item of items) {
          if (item.offset_start_ms <= ms) active = item;
          else break;
        }
        return active;
      }

      function activeAudio(items, ms) {
        for (const item of items) {
          if (item.offset_start_ms <= ms && item.offset_end_ms !== null && item.offset_end_ms > ms) return item;
        }
        return null;
      }

      function setPaused(source) {
        const track = tracks[source];
        if (track.audio) track.audio.pause();
        track.id = null;
        track.audio = null;
      }

      function syncTrack(source) {
        if (!manifest) return;
        const enabled = source === 'system' ? els.system.checked : els.mic.checked;
        const item = activeAudio(manifest.audio[source], currentMs);
        if (!playing || !enabled || !item || !item.blob_url) {
          setPaused(source);
          return;
        }
        const track = tracks[source];
        if (track.id !== item.id) {
          setPaused(source);
          track.id = item.id;
          track.audio = new Audio(item.blob_url);
        }
        const wanted = Math.max(0, (currentMs - item.offset_start_ms + item.blob_start_offset_ms) / 1000);
        try {
          if (Math.abs(track.audio.currentTime - wanted) > 0.35) track.audio.currentTime = wanted;
        } catch {}
        track.audio.playbackRate = Number(els.speed.value);
        if (track.audio.paused) track.audio.play().catch(() => {});
      }

      function syncAudio() {
        syncTrack('system');
        syncTrack('mic');
      }

      function pause() {
        playing = false;
        els.play.textContent = 'Play';
        setPaused('system');
        setPaused('mic');
      }

      function play() {
        if (!manifest || manifest.duration_ms <= 0) return;
        if (currentMs >= manifest.duration_ms) currentMs = 0;
        playing = true;
        lastFrame = performance.now();
        els.play.textContent = 'Pause';
        syncAudio();
      }

      function renderContext(screen) {
        if (!screen) {
          els.context.innerHTML = '<span>state</span><span>no screenshot</span>';
          els.ocr.textContent = '';
          return;
        }
        const rows = [
          ['time', screen.local_at],
          ['app', screen.window.app || ''],
          ['title', screen.window.title || ''],
          ['url', screen.window.url || ''],
          ['chunk', screen.id],
        ];
        els.context.innerHTML = rows
          .map(([k, v]) => '<span>' + k + '</span><span class="mono">' + escapeHtml(v || '-') + '</span>')
          .join('');
        els.ocr.textContent = screen.text || '';
      }

      function escapeHtml(value) {
        return String(value)
          .replaceAll('&', '&amp;')
          .replaceAll('<', '&lt;')
          .replaceAll('>', '&gt;')
          .replaceAll('"', '&quot;')
          .replaceAll("'", '&#39;');
      }

      function renderSubtitles() {
        if (!manifest || !els.subs.checked) {
          els.subtitles.innerHTML = '';
          return;
        }
        const active = manifest.segments.filter((segment) =>
          segment.offset_start_ms <= currentMs && segment.offset_end_ms >= currentMs && segment.text.trim()
        );
        els.subtitles.innerHTML = active
          .map((segment) => '<div class="subtitle"><b>' + segment.source + '</b>' + escapeHtml(segment.text) + '</div>')
          .join('');
      }

      function render() {
        if (!manifest) {
          els.seek.value = '0';
          els.seek.max = '0';
          els.time.textContent = '00:00 / 00:00';
          els.empty.textContent = bounds && bounds.from === null ? 'No captured data yet' : 'Choose a replay range';
          els.empty.hidden = false;
          els.screen.hidden = true;
          els.subtitles.innerHTML = '';
          renderContext(null);
          els.contextBlock.hidden = !els.contextToggle.checked;
          els.ocrBlock.hidden = !els.ocrToggle.checked;
          return;
        }
        currentMs = Math.max(0, Math.min(currentMs, manifest.duration_ms));
        els.seek.value = String(Math.floor(currentMs));
        els.time.textContent = fmt(currentMs) + ' / ' + fmt(manifest.duration_ms);
        const screen = activeByStart(manifest.screenshots, currentMs);
        if (screen && screen.blob_url) {
          if (activeScreenshotId !== screen.id) {
            els.screen.src = screen.blob_url;
            activeScreenshotId = screen.id;
          }
          els.empty.hidden = true;
          els.screen.hidden = false;
        } else {
          els.empty.textContent = manifest.screenshots.length ? 'Screenshot blob missing' : 'No screenshots in range';
          els.empty.hidden = false;
          els.screen.hidden = true;
          activeScreenshotId = null;
        }
        renderContext(screen);
        renderSubtitles();
        els.contextBlock.hidden = !els.contextToggle.checked;
        els.ocrBlock.hidden = !els.ocrToggle.checked;
      }

      function tick(now) {
        if (playing) {
          currentMs += (now - lastFrame) * Number(els.speed.value);
          lastFrame = now;
          if (currentMs >= manifest.duration_ms) pause();
          render();
          syncAudio();
        }
        requestAnimationFrame(tick);
      }

      async function loadBounds() {
        const response = await fetch(api('/api/range'), { cache: 'no-store' });
        if (!response.ok) throw new Error(await response.text());
        bounds = await response.json();
        if (bounds.from === null || bounds.to === null) {
          setPickerStatus('No captured data yet', true);
          return;
        }
        setPickerStatus('Captured range: ' + bounds.local_from + ' to ' + bounds.local_to);
      }

      async function loadManifest() {
        const from = fromLocalInput(els.fromInput.value);
        const to = fromLocalInput(els.toInput.value);
        if (!Number.isFinite(from) || !Number.isFinite(to)) {
          setPickerStatus('Choose a valid from/to range', true);
          return;
        }
        if (to < from) {
          setPickerStatus('End must be after start', true);
          return;
        }
        pause();
        manifest = null;
        activeScreenshotId = null;
        render();
        setPickerStatus('Loading replay...');
        const params = new URLSearchParams({
          token,
          from: String(Math.trunc(from)),
          to: String(Math.trunc(to)),
        });
        const response = await fetch('/api/manifest?' + params.toString(), { cache: 'no-store' });
        if (!response.ok) throw new Error(await response.text());
        manifest = await response.json();
        currentMs = 0;
        els.seek.max = String(manifest.duration_ms);
        els.rangeMeta.textContent = manifest.local_from + ' to ' + manifest.local_to + ' (' + manifest.timezone + ')';
        history.replaceState(null, '', '/?from=' + Math.trunc(from) + '&to=' + Math.trunc(to));
        setPickerStatus(
          'Loaded ' + manifest.screenshots.length + ' screenshots, '
          + manifest.audio.system.length + ' system chunks, '
          + manifest.audio.mic.length + ' mic chunks, '
          + manifest.segments.length + ' subtitles'
        );
        render();
      }

      async function boot() {
        await loadBounds();
        const params = new URLSearchParams(location.search);
        const initialFrom = parseTimeParam(params.get('from'));
        const initialTo = parseTimeParam(params.get('to'));
        if (Number.isFinite(initialFrom) && Number.isFinite(initialTo)) {
          els.preset.value = 'custom';
          setRangeFields(initialFrom, initialTo);
          await loadManifest();
        } else if (bounds && bounds.to !== null) {
          applyPreset();
        }
        els.preset.addEventListener('change', () => {
          applyPreset();
        });
        els.fromInput.addEventListener('input', () => {
          els.preset.value = 'custom';
        });
        els.toInput.addEventListener('input', () => {
          els.preset.value = 'custom';
        });
        els.loadRange.addEventListener('click', () => {
          loadManifest().catch((err) => setPickerStatus(err.message, true));
        });
        els.play.addEventListener('click', () => playing ? pause() : play());
        els.seek.addEventListener('input', () => {
          currentMs = Number(els.seek.value);
          lastFrame = performance.now();
          render();
          syncAudio();
        });
        for (const input of [els.speed, els.system, els.mic, els.subs, els.contextToggle, els.ocrToggle]) {
          input.addEventListener('change', () => {
            render();
            syncAudio();
          });
        }
        window.addEventListener('keydown', (event) => {
          if (event.target && ['INPUT', 'SELECT', 'BUTTON'].includes(event.target.tagName)) return;
          if (event.key === ' ') {
            event.preventDefault();
            playing ? pause() : play();
          }
          if (event.key === 'ArrowLeft') {
            currentMs -= event.shiftKey ? 30000 : 5000;
            render();
            syncAudio();
          }
          if (event.key === 'ArrowRight') {
            currentMs += event.shiftKey ? 30000 : 5000;
            render();
            syncAudio();
          }
        });
        setInterval(() => fetch(api('/api/ping'), { cache: 'no-store' }).catch(() => {}), 2000);
        render();
        requestAnimationFrame((now) => {
          lastFrame = now;
          tick(now);
        });
      }

      boot().catch((err) => {
        els.empty.textContent = 'Replay failed: ' + err.message;
      });
    </script>
  </body>
</html>`

export async function startReplayServer(options: ReplayServerOptions): Promise<void> {
  const authToken = token()
  const dbPath = options.dbPath
  let activeBlobs = new Map<string, ReplayBlobRef>()
  let lastPing = Date.now()
  let hadPing = false

  const isAuthorized = (url: URL): boolean => url.searchParams.get('token') === authToken

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (!isAuthorized(url)) return new Response('forbidden', { status: 403, headers: noStoreHeaders() })
      if (url.pathname === '/') {
        return new Response(REPLAY_HTML, {
          headers: noStoreHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
        })
      }
      if (url.pathname === '/api/range') {
        try {
          const bounds = withReplayStore(dbPath, (store) => store.bounds())
          return Response.json(bounds, { headers: noStoreHeaders() })
        } catch (err) {
          return new Response(err instanceof Error ? err.message : String(err), {
            status: 500,
            headers: noStoreHeaders(),
          })
        }
      }
      if (url.pathname === '/api/manifest') {
        try {
          const data = withReplayStore(dbPath, (store) =>
            store.load(url.searchParams.get('from'), url.searchParams.get('to')),
          )
          activeBlobs = data.blobs
          return Response.json(withBlobUrls(data.manifest, authToken), {
            headers: noStoreHeaders(),
          })
        } catch (err) {
          return new Response(err instanceof Error ? err.message : String(err), {
            status: 400,
            headers: noStoreHeaders(),
          })
        }
      }
      if (url.pathname === '/api/ping') {
        hadPing = true
        lastPing = Date.now()
        return Response.json({ ok: true }, { headers: noStoreHeaders() })
      }
      const blobMatch = url.pathname.match(/^\/blob\/([^/]+)$/)
      if (blobMatch?.[1]) {
        const id = decodeURIComponent(blobMatch[1])
        const blob = activeBlobs.get(id)
        if (!blob) return new Response('not found', { status: 404, headers: noStoreHeaders() })
        let stat
        try {
          stat = statSync(blob.path)
        } catch {
          return new Response('not found', { status: 404, headers: noStoreHeaders() })
        }
        return new Response(Bun.file(blob.path), {
          headers: noStoreHeaders({
            'Content-Type': blob.mime_type,
            'Content-Length': String(stat.size),
            'Accept-Ranges': 'bytes',
          }),
        })
      }
      return new Response('not found', { status: 404, headers: noStoreHeaders() })
    },
  })

  const initialParams = new URLSearchParams({ token: authToken })
  if (options.from !== undefined && options.to !== undefined) {
    initialParams.set('from', String(options.from))
    initialParams.set('to', String(options.to))
  }
  const url = `http://127.0.0.1:${server.port}/?${initialParams.toString()}`
  console.log(`replay: ${url}`)
  if (options.from !== undefined && options.to !== undefined) {
    console.log(`range: ${options.from} -> ${options.to}`)
  } else {
    console.log('range: choose in browser')
  }

  if (options.openBrowser !== false) {
    try {
      openUrl(url)
    } catch (err) {
      console.error(`failed to open browser: ${String(err)}`)
    }
  }

  await new Promise<void>((resolve) => {
    let done = false
    const close = () => {
      if (done) return
      done = true
      clearInterval(staleTimer)
      server.stop(true)
      resolve()
    }
    const staleTimer = setInterval(() => {
      const idleMs = Date.now() - lastPing
      // Once a real browser has pinged, 15s of silence means it's gone.
      // Otherwise only auto-give-up when we actually tried to open one — `--no-open`
      // is for scripted/headless use where Ctrl-C is the stop signal.
      if (hadPing && idleMs > 15_000) return close()
      if (options.openBrowser !== false && !hadPing && idleMs > 60_000) close()
    }, 2000)
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  })
}
