import { randomUUIDv7 } from 'bun'
import screenshot from 'screenshot-desktop'
import type { ScreenCaptureConfig } from '../config'
import type { EventBus, WindowContext } from '../core/events'
import type { OcrEngine } from '../process/types'
import type { BlobStore } from '../store/blobs'
import type { ChunkStore } from '../store/db'
import type { SckBus, SckFrameEvent } from './sck'
import { createWlcapBus } from './wlcap'

interface FrameBus {
  start(): Promise<void>
  stop(): Promise<void>
  onFrame(handler: (frame: SckFrameEvent) => void): () => void
}

export interface ScreenCaptureDeps {
  cfg: ScreenCaptureConfig
  blobs: BlobStore
  store: ChunkStore
  ocr: OcrEngine
  events: EventBus
  sck?: SckBus
  getWindow?: () => WindowContext | undefined
}

export interface CaptureRunner {
  stop: () => void
  done: Promise<void>
}

// Backend selection: macOS uses the ScreenCaptureKit helper (hpm-sck); Wayland
// uses the xdg-desktop-portal ScreenCast helper (hpm-wlcap); everything else
// falls back to screenshot-desktop, which shells out to ImageMagick's X11-only
// `import`.
export function startScreenCapture({
  cfg,
  blobs,
  store,
  ocr,
  events,
  sck,
  getWindow,
}: ScreenCaptureDeps): CaptureRunner {
  if (!cfg.enabled) {
    events.publish({
      type: 'log',
      at: Date.now(),
      level: 'info',
      message: 'screen capture disabled',
    })
    return { stop: () => {}, done: Promise.resolve() }
  }

  if (process.platform === 'darwin' && sck) {
    return startWorkerScreen({ cfg, blobs, store, ocr, events, getWindow }, sck, 'sck')
  }

  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
    const wlcap = createWlcapBus(
      {
        frameIntervalMs: cfg.interval_ms,
        imageFormat: cfg.format,
      },
      events,
    )
    return startWorkerScreen({ cfg, blobs, store, ocr, events, getWindow }, wlcap, 'wlcap')
  }

  let running = true
  let wakeSleep: (() => void) | undefined

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = undefined
        resolve()
      }, ms)
      wakeSleep = () => {
        clearTimeout(timer)
        wakeSleep = undefined
        resolve()
      }
    })
  }

  async function tick() {
    const start = Date.now()
    try {
      const buf = (await screenshot({ format: cfg.format })) as Buffer
      const id = randomUUIDv7()
      const path = await blobs.write('screenshot', id, cfg.format, buf)
      const text = await ocr.process(buf)
      const at = Date.now()
      const window = getWindow?.()
      store.insert({
        id,
        kind: 'screenshot',
        at,
        blob: path,
        bytes: buf.length,
        text,
        capture_ms: at - start,
        window,
        ocr: { engine: ocr.name },
      })
      events.publish({
        type: 'chunk',
        source: 'screen',
        at,
        id,
        path,
        bytes: buf.length,
        text_len: text.length,
        capture_ms: at - start,
        window,
      })
    } catch (err) {
      events.publish({ type: 'error', source: 'screen', at: Date.now(), message: String(err) })
    }
  }

  async function loop() {
    events.publish({
      type: 'started',
      source: 'screen',
      at: Date.now(),
      meta: { interval_ms: cfg.interval_ms, format: cfg.format },
    })
    while (running) {
      await tick()
      if (running) await sleep(cfg.interval_ms)
    }
    events.publish({ type: 'stopped', source: 'screen', at: Date.now() })
  }

  const done = loop()
  return {
    done,
    stop: () => {
      running = false
      wakeSleep?.()
    },
  }
}

function startWorkerScreen(
  { cfg, blobs, store, ocr, events, getWindow }: ScreenCaptureDeps,
  frames: FrameBus,
  engine: string,
): CaptureRunner {
  let running = true
  let lastAcceptedAt = 0

  async function processFrame(frame: SckFrameEvent) {
    const start = Date.now()
    const ext = frame.format === 'jpeg' ? 'jpg' : 'png'
    try {
      const id = randomUUIDv7()
      const path = await blobs.write('screenshot', id, ext, frame.image, frame.at)
      const text = await ocr.process(frame.image)
      const window = getWindow?.()
      store.insert({
        id,
        kind: 'screenshot',
        at: frame.at,
        blob: path,
        bytes: frame.image.length,
        text,
        capture_ms: Date.now() - start,
        window,
        ocr: { engine: ocr.name },
      })
      events.publish({
        type: 'chunk',
        source: 'screen',
        at: frame.at,
        id,
        path,
        bytes: frame.image.length,
        text_len: text.length,
        capture_ms: Date.now() - start,
        window,
      })
    } catch (err) {
      events.publish({ type: 'error', source: 'screen', at: Date.now(), message: String(err) })
    }
  }

  const done = (async () => {
    try {
      await frames.start()
    } catch (err) {
      events.publish({
        type: 'error',
        source: 'screen',
        at: Date.now(),
        message: `${engine} start failed: ${String(err)}`,
      })
      return
    }
    if (!running) return

    events.publish({
      type: 'started',
      source: 'screen',
      at: Date.now(),
      meta: { interval_ms: cfg.interval_ms, format: cfg.format, engine },
    })

    let pending: Promise<void> = Promise.resolve()
    const unsubscribe = frames.onFrame((frame) => {
      if (!running) return
      // Frames may arrive faster than interval_ms; throttle to interval_ms.
      if (frame.at - lastAcceptedAt < cfg.interval_ms) return
      lastAcceptedAt = frame.at
      pending = pending.then(() => processFrame(frame))
    })

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (!running) {
          clearInterval(timer)
          resolve()
        }
      }, 100)
    })

    unsubscribe()
    await pending.catch(() => {})
    events.publish({ type: 'stopped', source: 'screen', at: Date.now() })
  })()

  return {
    done,
    stop: () => {
      running = false
    },
  }
}
