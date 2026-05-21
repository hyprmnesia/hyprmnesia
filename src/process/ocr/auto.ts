import type { OcrEngine } from '../types'
import { NativeOcr } from './native'
import { NoopOcr } from './noop'
import { TesseractOcr } from './tesseract'

// auto-pick the best available engine for the current platform.
// preference order:
//   1. native (Windows.Media.Ocr) — Windows only, no install required
//   2. tesseract                  — macOS/Linux/Windows, requires user install
//   3. noop                       — never fails ready(), returns empty text
// the chosen engine is locked at construction by probing ready() in the order
// above, so subsequent process() calls don't re-probe.

export class AutoOcr implements OcrEngine {
  readonly name = 'auto'
  private chosen?: OcrEngine

  async ready(): Promise<boolean> {
    if (this.chosen) return true
    const candidates: OcrEngine[] = [new NativeOcr(), new TesseractOcr(), new NoopOcr()]
    for (const c of candidates) {
      if (await c.ready()) {
        this.chosen = c
        return true
      }
    }
    return false
  }

  async process(image: Buffer): Promise<string> {
    if (!this.chosen) {
      const ok = await this.ready()
      if (!ok) throw new Error('no ocr engine available')
    }
    return this.chosen!.process(image)
  }
}
