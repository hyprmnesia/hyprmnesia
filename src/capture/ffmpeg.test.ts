import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { ffmpegSearchPaths } from './ffmpeg'

test('ffmpeg search prefers packaged native binary before ffmpeg-static path', () => {
  const root = join('tmp', 'hyprmnesia')
  const staticPath = join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
  const nativePath = join(root, 'native', 'ffmpeg.exe')
  const paths = ffmpegSearchPaths({
    platform: 'win32',
    env: {},
    execPath: join(root, 'hpm.exe'),
    cwd: root,
    ffmpegStaticPath: staticPath,
  })

  expect(paths).toContain(nativePath)
  expect(paths.indexOf(nativePath)).toBeLessThan(paths.indexOf(staticPath))
})

test('ffmpeg search avoids ffmpeg-static on Linux', () => {
  const root = join('tmp', 'hyprmnesia')
  const staticPath = join(root, 'node_modules', 'ffmpeg-static', 'ffmpeg')
  const paths = ffmpegSearchPaths({
    platform: 'linux',
    env: {},
    execPath: join(root, 'hpm'),
    cwd: root,
    ffmpegStaticPath: staticPath,
  })

  expect(paths).toContain('/usr/bin/ffmpeg')
  expect(paths).not.toContain(staticPath)
})
