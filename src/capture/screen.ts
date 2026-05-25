import { randomUUIDv7 } from 'bun'
import screenshot from 'screenshot-desktop'
import type { ScreenCaptureConfig } from '../config'
import type { EventBus, WindowContext } from '../core/events'
import type { OcrEngine } from '../process/types'
import type { BlobStore } from '../store/blobs'
import type { ChunkStore } from '../store/db'
import { needsImageTranscode, transcodeImage } from './ffmpeg'
import type { SckBus, SckFrameEvent } from './sck'

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

// TODO(Linux/Wayland): screenshot-desktop shells out to ImageMagick's `import`,
// which only works under X11. On Wayland sessions every tick fails. For now,
// users must log into an Xorg session. Full Wayland support (Portal Screenshot
// or ScreenCast/PipeWire) is tracked in
// https://github.com/hyprmnesia/hyprmnesia/issues/8
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
    return startSckScreen({ cfg, blobs, store, ocr, events, sck, getWindow })
  }

  if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY && !process.env.DISPLAY) {
    events.publish({
      type: 'error',
      source: 'screen',
      at: Date.now(),
      message:
        'Wayland screen capture is not implemented yet — see https://github.com/hyprmnesia/hyprmnesia/issues/8. Log into an Xorg session for now, or disable screen capture with --no-screen.',
    })
    return { stop: () => {}, done: Promise.resolve() }
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

  const qualityOpts = { format: cfg.format, quality: cfg.quality, maxWidth: cfg.max_width }
  const transcode = needsImageTranscode(qualityOpts)

  async function tick() {
    const start = Date.now()
    try {
      const raw = (await screenshot({ format: cfg.format })) as Buffer
      const buf = transcode ? await transcodeImage(raw, qualityOpts) : raw
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

function startSckScreen({
  cfg,
  blobs,
  store,
  ocr,
  events,
  sck,
  getWindow,
}: ScreenCaptureDeps & { sck: SckBus }): CaptureRunner {
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
      await sck.start()
    } catch (err) {
      events.publish({
        type: 'error',
        source: 'screen',
        at: Date.now(),
        message: `sck start failed: ${String(err)}`,
      })
      return
    }
    if (!running) return

    events.publish({
      type: 'started',
      source: 'screen',
      at: Date.now(),
      meta: { interval_ms: cfg.interval_ms, format: cfg.format, engine: 'sck' },
    })

    let pending: Promise<void> = Promise.resolve()
    const unsubscribe = sck.onFrame((frame) => {
      if (!running) return
      // SCK emits frames at the display refresh rate; throttle to interval_ms.
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
