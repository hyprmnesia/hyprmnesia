// Generic OS-keychain-backed secret storage: DPAPI (Windows), Keychain (macOS),
// Secret Service (Linux), with a 0600-file fallback. This is the same pattern
// used by the MCP auth verifier in src/mcp/auth.ts, generalized so the index-DB
// encryption key (#12) can reuse it. Unlike the auth store it holds an opaque
// secret value (no verifier prefix). auth.ts could be migrated onto this later.

import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface SecretStoreSpec {
  // Keychain service name (macOS) and human-facing label (Linux).
  service: string
  label: string
  // Secret Service lookup attributes, e.g. ['service','hyprmnesia','name','index-key'].
  attributes: string[]
  // Plaintext 0600 fallback file (all platforms).
  filePath: string
  // DPAPI-encrypted file (Windows only).
  dpapiPath: string
}

interface Backend {
  readonly name: string
  read(): string | undefined
  write(value: string): void
  delete(): void
}

export interface SecretStore {
  // Chain description, e.g. 'windows-dpapi-file -> file'.
  readonly name: string
  // True when a real OS keychain backend (not the plaintext file) is available.
  readonly secure: boolean
  read(): string | undefined
  // Returns the name of the backend the value was written to.
  write(value: string): string
  delete(): void
}

class FileBackend implements Backend {
  readonly name = 'file'
  constructor(private readonly path: string) {}

  read(): string | undefined {
    if (!existsSync(this.path)) return undefined
    const raw = readFileSync(this.path, 'utf8').trim()
    return raw === '' ? undefined : raw
  }

  write(value: string): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(this.path, `${value}\n`, { mode: 0o600 })
    try {
      chmodSync(this.path, 0o600)
    } catch {}
  }

  delete(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
    } catch {}
  }
}

class MacKeychainBackend implements Backend {
  readonly name = 'macos-keychain'
  constructor(private readonly service: string) {}

  read(): string | undefined {
    const r = spawnSync(
      'security',
      ['find-generic-password', '-s', this.service, '-a', account(), '-w'],
      { encoding: 'utf8', windowsHide: true },
    )
    if (r.status !== 0) return undefined
    const v = r.stdout.trim()
    return v === '' ? undefined : v
  }

  write(value: string): void {
    const r = spawnSync(
      'security',
      ['add-generic-password', '-U', '-s', this.service, '-a', account(), '-w', value],
      { encoding: 'utf8', windowsHide: true },
    )
    if (r.status !== 0) throw new Error(r.stderr.trim() || 'security failed')
  }

  delete(): void {
    spawnSync('security', ['delete-generic-password', '-s', this.service, '-a', account()], {
      encoding: 'utf8',
      windowsHide: true,
    })
  }
}

class LinuxSecretServiceBackend implements Backend {
  readonly name = 'secret-service'
  constructor(
    private readonly label: string,
    private readonly attributes: string[],
  ) {}

  read(): string | undefined {
    const r = spawnSync('secret-tool', ['lookup', ...this.attributes], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (r.status !== 0) return undefined
    const v = r.stdout.trim()
    return v === '' ? undefined : v
  }

  write(value: string): void {
    const r = spawnSync('secret-tool', ['store', '--label', this.label, ...this.attributes], {
      encoding: 'utf8',
      input: `${value}\n`,
      windowsHide: true,
    })
    if (r.status !== 0) throw new Error(r.stderr.trim() || 'secret-tool failed')
  }

  delete(): void {
    spawnSync('secret-tool', ['clear', ...this.attributes], { encoding: 'utf8', windowsHide: true })
  }
}

class WindowsDpapiBackend implements Backend {
  readonly name = 'windows-dpapi-file'
  constructor(private readonly path: string) {}

  read(): string | undefined {
    if (!existsSync(this.path)) return undefined
    const script = `
$ErrorActionPreference = 'Stop'
[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
$path = ${psQuote(this.path)}
if (!(Test-Path -LiteralPath $path)) { exit 2 }
$raw = [IO.File]::ReadAllText($path)
$bytes = [Convert]::FromBase64String($raw)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
`
    const r = runPowerShell(script)
    if (r.status !== 0) return undefined
    const v = r.stdout.trim()
    return v === '' ? undefined : v
  }

  write(value: string): void {
    const script = `
$ErrorActionPreference = 'Stop'
[Reflection.Assembly]::LoadWithPartialName('System.Security') | Out-Null
$path = ${psQuote(this.path)}
$dir = Split-Path -Parent $path
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$plain = [Text.Encoding]::UTF8.GetBytes($env:HPM_SECRET_VALUE)
$bytes = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText($path, [Convert]::ToBase64String($bytes))
`
    const r = runPowerShell(script, { HPM_SECRET_VALUE: value })
    if (r.status !== 0) throw new Error(r.stderr.trim() || 'PowerShell DPAPI failed')
  }

  delete(): void {
    try {
      if (existsSync(this.path)) unlinkSync(this.path)
    } catch {}
  }
}

// Tries each backend in priority order. On a successful write to a higher
// backend, lower-priority copies are cleared so the secret isn't left lying in
// the plaintext fallback.
class CompositeSecretStore implements SecretStore {
  readonly name: string
  readonly secure: boolean

  constructor(private readonly backends: Backend[]) {
    this.name = backends.map((b) => b.name).join(' -> ')
    this.secure = backends.some((b) => b.name !== 'file')
  }

  read(): string | undefined {
    for (const b of this.backends) {
      try {
        const v = b.read()
        if (v) return v
      } catch {}
    }
    return undefined
  }

  write(value: string): string {
    let lastError: unknown
    for (let i = 0; i < this.backends.length; i++) {
      const b = this.backends[i]!
      try {
        b.write(value)
        for (const lower of this.backends.slice(i + 1)) {
          try {
            lower.delete()
          } catch {}
        }
        return b.name
      } catch (err) {
        lastError = err
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  delete(): void {
    for (const b of this.backends) {
      try {
        b.delete()
      } catch {}
    }
  }
}

export function createSecretStore(spec: SecretStoreSpec): SecretStore {
  const file = new FileBackend(spec.filePath)
  if (process.platform === 'win32') {
    return new CompositeSecretStore([new WindowsDpapiBackend(spec.dpapiPath), file])
  }
  if (process.platform === 'darwin' && commandExists('security')) {
    return new CompositeSecretStore([new MacKeychainBackend(spec.service), file])
  }
  if (process.platform === 'linux' && commandExists('secret-tool')) {
    return new CompositeSecretStore([
      new LinuxSecretServiceBackend(spec.label, spec.attributes),
      file,
    ])
  }
  return new CompositeSecretStore([file])
}

function account(): string {
  return process.env.USER || process.env.USERNAME || 'default'
}

function commandExists(command: string): boolean {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  const r = spawnSync(lookup, [command], { encoding: 'utf8', stdio: 'ignore', windowsHide: true })
  return r.status === 0
}

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function runPowerShell(script: string, extraEnv: Record<string, string> = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', env: { ...process.env, ...extraEnv }, windowsHide: true },
  )
}
