// step 1: bundle src/cli.ts to dist/bundle.mjs.
// step 2: shell out to `bun build --compile dist/bundle.mjs` to produce dist/hpm.
//
// the plugin handles two known bundler quirks:
//
// 1. stub optional deps that are dynamically required but never used:
//    - react-devtools-core : ink only loads it when DEV=true
//      see https://github.com/vadimdemedes/ink/issues/886
//    - mock-aws-s3 / aws-sdk / nock : node-pre-gyp uses them only when
//      republishing prebuilt binaries to S3
//    without stubs, --compile produces a binary that tries to resolve them
//    at startup.
//
// 2. redirect `es-toolkit/compat` to the deep `throttle.mjs` file. the compat
//    barrel is `sideEffects: false` and bun tree-shakes the re-export chain
//    to an empty module, leaving ink.js with `throttle` as a free variable.
//    we bypass the barrel.
//
// 3. rewrite `ansi-escapes` through a shim. its `export * as default` barrel
//    can compile to Ink references like `default2.eraseLines(...)` without a
//    generated `default2` binding. importing the base module as a namespace
//    gives Bun an explicit default object to keep.
//
// 4. copy get-windows' native addon next to the executable. `get-windows`
//    normally asks node-pre-gyp to locate the addon via its package.json, but
//    `import.meta.url` points inside Bun's virtual executable filesystem after
//    --compile, so the package-relative lookup cannot work there.
//
// 5. build native helpers as sibling executables in dist/native/:
//    - hpm-tray: tray supervisor (uses windows_subsystem="windows" — no console).
//    - hpm-ocr : OCR helper, writes JSON to stdout (must be a console binary).
//    - hpm-asr : Parakeet live ASR helper, speaks NDJSON over stdio.
//    - hpm-sck : macOS ScreenCaptureKit helper (system audio + screen frames),
//                NDJSON over stdio. Built everywhere by `cargo --workspace`
//                but only copied into dist/native on darwin (no-op stub
//                elsewhere).
//    - hpm-wasapi : Windows WASAPI loopback helper, writes raw s16le mono PCM
//                to stdout. Built everywhere by `cargo --workspace` but only
//                copied into dist/native on win32 (no-op stub elsewhere).
//    All crates live in a single Cargo workspace at the repo root so we build
//    them in one cargo invocation.

import { existsSync } from 'node:fs'
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { $ } from 'bun'

const STUBS = new Set(['react-devtools-core', 'mock-aws-s3', 'aws-sdk', 'nock'])
const COMPAT_THROTTLE = resolve('./node_modules/es-toolkit/dist/compat/function/throttle.mjs')
const ANSI_ESCAPES_BASE = './node_modules/ansi-escapes/base.js'
const GET_WINDOWS_NATIVE_SRC = resolve(
  './node_modules/get-windows/lib/binding/napi-9-win32-unknown-x64/node-get-windows.node',
)
const GET_WINDOWS_NATIVE_DEST = resolve('./dist/native/node-get-windows.node')
const EXE = process.platform === 'win32' ? '.exe' : ''
const NATIVE_BINS: readonly string[] = [
  'hpm-tray',
  'hpm-ocr',
  'hpm-asr',
  ...(process.platform === 'darwin' ? ['hpm-sck'] : []),
  ...(process.platform === 'win32' ? ['hpm-wasapi'] : []),
]
const NATIVE_DEST_DIR = resolve('./dist/native')

const bundle = await Bun.build({
  entrypoints: ['./src/cli.ts'],
  outdir: './dist',
  naming: 'bundle.mjs',
  target: 'bun',
  format: 'esm',
  plugins: [
    {
      name: 'patch-deps',
      setup(build) {
        build.onResolve({ filter: /.*/ }, (args) => {
          if (STUBS.has(args.path)) return { path: args.path, namespace: 'stub' }
          if (args.path === 'es-toolkit/compat') return { path: COMPAT_THROTTLE }
          if (args.path === 'ansi-escapes')
            return { path: args.path, namespace: 'ansi-escapes-shim' }
          return undefined
        })
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export default {}; export const __stubbed = true;',
          loader: 'js',
        }))
        build.onLoad({ filter: /.*/, namespace: 'ansi-escapes-shim' }, () => ({
          contents: `
            export * from ${JSON.stringify(ANSI_ESCAPES_BASE)};
            import * as ansiEscapes from ${JSON.stringify(ANSI_ESCAPES_BASE)};
            export default ansiEscapes;
          `,
          loader: 'js',
          resolveDir: process.cwd(),
        }))
      },
    },
  ],
})

if (!bundle.success) {
  for (const log of bundle.logs) console.error(log)
  process.exit(1)
}

await $`bun build --compile ./dist/bundle.mjs --outfile ./dist/hpm`

if (process.platform === 'win32' && existsSync(GET_WINDOWS_NATIVE_SRC)) {
  await mkdir(dirname(GET_WINDOWS_NATIVE_DEST), { recursive: true })
  await copyFile(GET_WINDOWS_NATIVE_SRC, GET_WINDOWS_NATIVE_DEST)
}

await $`cargo build --release --workspace`
await mkdir(NATIVE_DEST_DIR, { recursive: true })
for (const name of NATIVE_BINS) {
  const file = `${name}${EXE}`
  const src = resolve(`./target/release/${file}`)
  if (!existsSync(src)) throw new Error(`cargo did not produce ${src}`)
  await copyFile(src, resolve(NATIVE_DEST_DIR, file))
  await rm(resolve(`./dist/${file}`), { force: true })
}

for (const name of await readdir(resolve('./target/release')).catch(() => [])) {
  if (/^(onnxruntime|DirectML)/i.test(name)) {
    await copyFile(resolve('./target/release', name), resolve(NATIVE_DEST_DIR, name))
  }
}

console.log(`built dist/hpm with native helpers: ${NATIVE_BINS.join(', ')}`)
