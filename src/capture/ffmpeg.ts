import { existsSync } from 'node:fs'
import ffmpegPath from 'ffmpeg-static'

export const SYSTEM_AUDIO_DSHOW_DEVICE = 'virtual-audio-capturer'

let cachedFfmpegPath: string | null = null

export function getFfmpegPath(): string {
  if (cachedFfmpegPath) return cachedFfmpegPath
  if (process.platform === 'linux') {
    // ffmpeg-static on Linux is built without libpulse / libpipewire, so it
    // cannot capture from `-f pulse`. Prefer the system ffmpeg (Debian/Ubuntu
    // builds enable libpulse by default).
    for (const candidate of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
      if (existsSync(candidate)) {
        cachedFfmpegPath = candidate
        return cachedFfmpegPath
      }
    }
    throw new Error(
      'ffmpeg not found on Linux. Install it (e.g. `sudo apt install ffmpeg`) — the bundled ffmpeg-static binary lacks PulseAudio support.',
    )
  }
  if (!ffmpegPath) throw new Error('ffmpeg-static did not provide a binary for this platform')
  cachedFfmpegPath = ffmpegPath
  return cachedFfmpegPath
}

export async function listDshowAudioDevices(): Promise<string[]> {
  // FFmpeg is a console binary on Windows; hide its transient console while we
  // query dshow devices in daemon/TUI flows.
  const proc = Bun.spawn(
    [getFfmpegPath(), '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const devices: string[] = []
  const re = /"([^"]+)" \(audio\)/g
  let m: RegExpExecArray | null = re.exec(stderr)
  while (m !== null) {
    if (m[1]) devices.push(m[1])
    m = re.exec(stderr)
  }
  return devices
}

export interface AvfoundationAudioDevice {
  index: number
  name: string
}

export async function listAvfoundationAudioDevices(): Promise<AvfoundationAudioDevice[]> {
  const proc = Bun.spawn(
    [getFfmpegPath(), '-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { stdout: 'pipe', stderr: 'pipe', windowsHide: true },
  )
  await proc.exited
  const stderr = await new Response(proc.stderr).text()
  const devices: AvfoundationAudioDevice[] = []
  let inAudio = false
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/^\[AVFoundation[^\]]*\]\s*/, '')
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudio = true
      continue
    }
    if (/AVFoundation video devices:/i.test(line)) {
      inAudio = false
      continue
    }
    if (!inAudio) continue
    const m = line.match(/^\[(\d+)\]\s*(.+?)\s*$/)
    if (m && m[1] && m[2]) devices.push({ index: Number(m[1]), name: m[2] })
  }
  return devices
}

export function buildMicInputArgs(device: string): string[] {
  switch (process.platform) {
    case 'win32':
      return ['-f', 'dshow', '-i', `audio=${device}`]
    case 'darwin':
      return ['-f', 'avfoundation', '-i', `:${device === 'default' ? '0' : device}`]
    default:
      return ['-f', 'pulse', '-i', device === 'default' ? 'default' : device]
  }
}

export function buildSystemAudioInputArgs(device: string): string[] {
  switch (process.platform) {
    case 'win32':
      return [
        '-f',
        'dshow',
        '-i',
        `audio=${device === 'default' ? SYSTEM_AUDIO_DSHOW_DEVICE : device}`,
      ]
    case 'darwin':
      return ['-f', 'avfoundation', '-i', `:${device === 'default' ? 'BlackHole 2ch' : device}`]
    default:
      return ['-f', 'pulse', '-i', device === 'default' ? '@DEFAULT_MONITOR@' : device]
  }
}
