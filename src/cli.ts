#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, watch } from 'node:fs'
import { dirname, join } from 'node:path'
import { type Config, ensureDefaultConfig, loadConfig } from './config'
import {
  clearStopRequest,
  daemonPid,
  ERR_LOG_FILE,
  isDaemonAlive,
  isStopRequested,
  LEVELS_FILE,
  LOG_FILE,
  readLevels,
  spawnDaemon,
  stopDaemon,
} from './core/daemon'
import { subscribeLevelsFile, subscribeNdjsonStdout } from './core/logger'
import { makeOrchestrator } from './core/orchestrator'
import { log } from './log'

function parseFlags(argv: string[]): Record<string, string | boolean> {
  // Accepts both `--foo value` and `-n value` so `hpm logs -n 50` reads naturally
  // alongside long flags like `--no-follow`. Short and long share the same key
  // namespace; callers read by the stripped name (e.g. flags["n"], flags["no-follow"]).
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    let key: string | undefined
    if (a.startsWith('--')) key = a.slice(2)
    else if (a.startsWith('-') && a.length > 1) key = a.slice(1)
    else continue
    const next = argv[i + 1]
    if (next && !next.startsWith('-')) {
      out[key] = next
      i++
    } else {
      out[key] = true
    }
  }
  return out
}

function applyFlags(cfg: Config, flags: Record<string, string | boolean>) {
  const n = (v: unknown) => (typeof v === 'string' ? Number(v) : NaN)
  const s = (v: unknown) => (typeof v === 'string' ? v : undefined)
  if (flags['screen-interval']) cfg.capture.screen.interval_ms = n(flags['screen-interval'])
  if (flags['audio-chunk']) {
    const ms = n(flags['audio-chunk'])
    cfg.capture.audio.mic.chunk_ms = ms
    cfg.capture.audio.system.chunk_ms = ms
  }
  if (flags['no-screen']) cfg.capture.screen.enabled = false
  if (flags['no-audio']) {
    cfg.capture.audio.mic.enabled = false
    cfg.capture.audio.system.enabled = false
  }
  if (flags['no-mic']) cfg.capture.audio.mic.enabled = false
  if (flags['no-system-audio']) cfg.capture.audio.system.enabled = false
  const mic = s(flags['mic-device'])
  if (mic) cfg.capture.audio.mic.device = mic
  const sys = s(flags['system-device'])
  if (sys) cfg.capture.audio.system.device = sys
  const dataDir = s(flags['data-dir'])
  if (dataDir) cfg.storage.path = dataDir
}

function help() {
  console.log(`hpm - hyprmnesia

usage:
  hpm [flags]            launch tray and start the capture daemon
  hpm start [flags]      launch tray and start the capture daemon
  hpm tui                open the interactive TUI
  hpm logs [-n N] [--no-follow]
                         tail the daemon log (default: last 10 lines + follow)
  hpm stop               stop the running daemon
  hpm status [--json]    print daemon status
  hpm mcp [flags]        run the read-only MCP server
  hpm version            print version

flags (for hpm/start):
  --config <path>        config file (default: ~/.hyprmnesia/config.yaml)
  --screen-interval <ms> override screen capture interval
  --audio-chunk <ms>     override chunk duration for both mic and system
  --mic-device <name>    override mic device (default: auto)
  --system-device <name> override system audio device (default: default)
  --no-screen            disable screen capture
  --no-audio             disable both mic and system audio
  --no-mic               disable mic capture only
  --no-system-audio      disable system audio capture only
  --data-dir <path>      override storage path

flags (for hpm mcp):
  --config <path>        config file (default: ~/.hyprmnesia/config.yaml)
  --db <path>            SQLite index path (default: ~/.hyprmnesia/index.db)
  --transport <name>     MCP transport: stdio or http
  --bind <addr>          HTTP bind address (default: 127.0.0.1)
  --port <n>             HTTP port (default: 37373)
`)
}

async function cmdCapture(flags: Record<string, string | boolean>) {
  // Internal worker invoked by spawnDaemon. The `_` prefix hides it from help
  // output and signals "not for direct CLI use": users launch the tray with
  // `hpm`/`hpm start`, while the daemon spawner runs this capture worker.
  const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined
  const cfg = loadConfig(configPath)
  applyFlags(cfg, flags)
  clearStopRequest()

  const orch = makeOrchestrator(cfg)
  subscribeNdjsonStdout(orch.events)
  subscribeLevelsFile(orch.events, LEVELS_FILE)

  try {
    await orch.start()
  } catch (err) {
    log.error('failed to start orchestrator', { err: String(err) })
    await orch.stop().catch(() => {})
    process.exit(1)
  }

  let shuttingDown = false
  let stopWatch: ReturnType<typeof setInterval>
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    void (async () => {
      try {
        clearInterval(stopWatch)
        await orch.stop()
        clearStopRequest()
        process.exit(0)
      } catch (err) {
        log.error('failed to stop orchestrator cleanly', { err: String(err) })
        clearStopRequest()
        process.exit(1)
      }
    })()
  }
  stopWatch = setInterval(() => {
    if (isStopRequested()) shutdown()
  }, 250)
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function cmdTui() {
  ensureDefaultConfig()
  const { runTui } = await import('./tui/run')
  await runTui()
}

async function cmdMcp(flags: Record<string, string | boolean>) {
  const configPath = typeof flags['config'] === 'string' ? flags['config'] : undefined
  const cfg = loadConfig(configPath)
  applyMcpFlags(cfg, flags)
  const { startMcpServer } = await import('./mcp/server')
  await startMcpServer({
    dbPath: typeof flags['db'] === 'string' ? flags['db'] : undefined,
    transport: cfg.mcp.transport,
    bind: cfg.mcp.bind,
    port: cfg.mcp.port,
  })
}

function applyMcpFlags(cfg: Config, flags: Record<string, string | boolean>) {
  if (typeof flags['transport'] === 'string') {
    const transport = flags['transport']
    if (transport !== 'stdio' && transport !== 'http') {
      console.error(`invalid MCP transport: ${transport} (expected stdio or http)`)
      process.exit(1)
    }
    cfg.mcp.transport = transport
  }
  if (typeof flags['bind'] === 'string') cfg.mcp.bind = flags['bind']
  if (typeof flags['port'] === 'string') {
    const port = Number(flags['port'])
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`invalid MCP port: ${flags['port']}`)
      process.exit(1)
    }
    cfg.mcp.port = port
  }
}

function flagsToArgv(flags: Record<string, string | boolean>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(flags)) {
    if (typeof v === 'boolean') {
      if (v) out.push(`--${k}`)
    } else {
      out.push(`--${k}`, v)
    }
  }
  return out
}

function cmdStartDaemon(flags: Record<string, string | boolean>) {
  if (isDaemonAlive()) {
    console.log(`daemon already running (pid ${daemonPid()})`)
    return
  }
  try {
    const pid = spawnDaemon(flagsToArgv(flags))
    console.log(`hyprmnesia started (pid ${pid})`)
    console.log(`logs: ${LOG_FILE}`)
    if (process.platform === 'win32') console.log(`errors: ${ERR_LOG_FILE}`)
  } catch (err) {
    console.error(String(err))
    process.exit(1)
  }
}

function cmdStart(flags: Record<string, string | boolean>) {
  cmdStartDaemon(flags)
}

function cmdStop() {
  const r = stopDaemon()
  if (r.stopped) console.log(`daemon stopped (pid ${r.pid})`)
  else if (r.pid) console.log(`pid file present (${r.pid}) but process not alive — cleaned up`)
  else console.log('no daemon running')
}

function statusPayload() {
  const pid = daemonPid()
  const running = pid !== undefined && isDaemonAlive()
  return {
    running,
    pid: running ? pid : null,
    logs: LOG_FILE,
    errors: process.platform === 'win32' ? ERR_LOG_FILE : LOG_FILE,
    levels: readLevels(),
  }
}

function cmdStatus(flags: Record<string, string | boolean>) {
  if (flags['json']) {
    console.log(JSON.stringify(statusPayload()))
    return
  }

  const pid = daemonPid()
  if (pid === undefined) {
    console.log('daemon: not running')
    return
  }
  if (isDaemonAlive()) {
    console.log(`daemon: running (pid ${pid})`)
    console.log(`logs: ${LOG_FILE}`)
    if (process.platform === 'win32') console.log(`errors: ${ERR_LOG_FILE}`)
  } else {
    console.log(`daemon: stale pid ${pid} (process dead, file will be cleaned up on next start)`)
  }
}

function cmdLogs(flags: Record<string, string | boolean>) {
  const rawN = flags['n']
  const n = typeof rawN === 'string' ? Math.max(0, Number(rawN)) : 10
  if (!Number.isFinite(n)) {
    console.error(`invalid -n value: ${rawN}`)
    process.exit(1)
  }
  const follow = !flags['no-follow']

  if (!existsSync(LOG_FILE)) {
    console.error(`no log file at ${LOG_FILE}`)
    if (!follow) process.exit(1)
  }

  let position = 0
  if (existsSync(LOG_FILE)) {
    const content = readFileSync(LOG_FILE, 'utf8')
    const lines = content.split('\n')
    const nonEmpty = lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines
    const tail = nonEmpty.slice(Math.max(0, nonEmpty.length - n))
    for (const line of tail) process.stdout.write(line + '\n')
    position = Buffer.byteLength(content, 'utf8')
  }

  if (!follow) return

  const watcher = watch(LOG_FILE, () => {
    try {
      const stats = statSync(LOG_FILE)
      // A shrunk file means spawnDaemon rotated it under us; start over from
      // the new head so we don't seek past the end of the fresh log.
      if (stats.size < position) position = 0
      if (stats.size === position) return
      const fd = openSync(LOG_FILE, 'r')
      const buf = Buffer.alloc(stats.size - position)
      readSync(fd, buf, 0, buf.length, position)
      closeSync(fd)
      process.stdout.write(buf.toString('utf8'))
      position = stats.size
    } catch {
      // file may have been rotated; the next watch event will re-read
    }
  })

  const cleanup = () => {
    watcher.close()
    process.exit(0)
  }
  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

function trayBinaryName(): string {
  return process.platform === 'win32' ? 'hpm-tray.exe' : 'hpm-tray'
}

function findTrayBinary(): string | undefined {
  const name = trayBinaryName()
  const candidates = [
    join(dirname(process.execPath), 'native', name),
    join(dirname(process.execPath), name),
    join(process.cwd(), 'dist', 'native', name),
    join(process.cwd(), 'dist', name),
    join(process.cwd(), 'tray', 'target', 'release', name),
    join(process.cwd(), 'tray', 'target', 'debug', name),
  ]
  return candidates.find((candidate) => existsSync(candidate))
}

function launchTray(flags: Record<string, string | boolean>, opts: { autoStart: boolean }) {
  const tray = findTrayBinary()
  if (!tray) {
    console.error(`tray binary not found; run: bun run build`)
    process.exit(1)
  }

  const proc = spawn(tray, flagsToArgv(flags), {
    detached: true,
    env: opts.autoStart ? process.env : { ...process.env, HPM_TRAY_NO_AUTOSTART: '1' },
    stdio: 'ignore',
    windowsHide: true,
  })
  proc.unref()
}

function ensureTray(
  flags: Record<string, string | boolean> = {},
  opts: { autoStart?: boolean } = {},
) {
  ensureDefaultConfig(typeof flags['config'] === 'string' ? flags['config'] : undefined)
  launchTray(flags, { autoStart: opts.autoStart ?? false })
}

const argv = process.argv.slice(2)
const firstArg = argv[0]
const cmd = firstArg && !firstArg.startsWith('-') ? firstArg : undefined
const rest = cmd === undefined ? argv : argv.slice(1)
const flags = parseFlags(rest)

if (flags['help'] || flags['h']) {
  help()
  process.exit(0)
}

switch (cmd) {
  case undefined:
  case 'start':
    ensureTray(flags)
    cmdStart(flags)
    break
  case '_daemon':
    cmdStartDaemon(flags)
    break
  case '_capture':
    await cmdCapture(flags)
    break
  case 'tui':
    ensureTray()
    await cmdTui()
    break
  case 'logs':
    ensureTray()
    cmdLogs(flags)
    break
  case 'stop':
    ensureTray()
    cmdStop()
    break
  case 'status':
    ensureTray()
    cmdStatus(flags)
    break
  case '_status':
    cmdStatus(flags)
    break
  case 'mcp':
    await cmdMcp(flags)
    break
  case 'version':
    console.log('0.0.1')
    break
  case 'help':
  case '--help':
  case '-h':
    help()
    break
  default:
    console.error(`unknown command: ${cmd}`)
    help()
    process.exit(1)
}
