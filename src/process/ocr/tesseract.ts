import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUIDv7 } from 'bun'
import type { OcrEngine } from '../types'

// fallback engine for macOS/Linux that shells out to `tesseract`.
// expects the `tesseract` binary to be available in PATH.
// install:  macOS  → `brew install tesseract`
//           debian → `apt install tesseract-ocr`

function which(cmd: string): Promise<string | undefined> {
  return new Promise((resolveP) => {
    const lookup = process.platform === 'win32' ? 'where' : 'which'
    const proc = spawn(lookup, [cmd], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    proc.on('close', (code) => {
      if (code !== 0) {
        resolveP(undefined)
        return
      }
      const first = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0)
      resolveP(first)
    })
    proc.on('error', () => resolveP(undefined))
  })
}

function runTesseract(binary: string, imagePath: string, lang?: string): Promise<string> {
  return new Promise((resolveP, reject) => {
    const args = [imagePath, '-']
    if (lang) args.push('-l', lang)
    args.push('--psm', '6')
    const proc = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    proc.stdout.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    proc.stderr.on('data', (b: Buffer) => {
      err += b.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`tesseract exited ${code}: ${err.trim()}`))
        return
      }
      resolveP(out)
    })
  })
}

export interface TesseractOptions {
  lang?: string
}

export class TesseractOcr implements OcrEngine {
  readonly name = 'tesseract'
  private binary?: string
  private readyCache?: boolean
  constructor(private opts: TesseractOptions = {}) {}

  async ready(): Promise<boolean> {
    if (this.readyCache !== undefined) return this.readyCache
    this.binary = await which('tesseract')
    this.readyCache = this.binary !== undefined
    return this.readyCache
  }

  async process(image: Buffer): Promise<string> {
    if (!this.binary) throw new Error('tesseract not found in PATH')
    const tmp = join(tmpdir(), `hpm-ocr-${randomUUIDv7()}.png`)
    await mkdir(dirname(tmp), { recursive: true })
    await writeFile(tmp, image)
    try {
      const text = await runTesseract(this.binary, tmp, this.opts.lang)
      return text.trim()
    } finally {
      await Bun.file(tmp)
        .delete()
        .catch(() => {})
    }
  }
}
