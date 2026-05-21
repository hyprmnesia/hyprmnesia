import type { EngineConfig } from '../../config'
import type { OcrEngine } from '../types'
import { AutoOcr } from './auto'
import { NativeOcr } from './native'
import { NoopOcr } from './noop'
import { TesseractOcr } from './tesseract'

export function makeOcr(cfg: EngineConfig): OcrEngine {
  const opts = cfg.options ?? {}
  switch (cfg.engine) {
    case 'noop':
      return new NoopOcr()
    case 'native':
      return new NativeOcr()
    case 'tesseract':
      return new TesseractOcr({ lang: typeof opts.lang === 'string' ? opts.lang : undefined })
    case 'auto':
      return new AutoOcr()
    default:
      throw new Error(`unknown ocr engine: ${cfg.engine}`)
  }
}
