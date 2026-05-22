import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const versionArg = process.argv[2]?.replace(/^v/, '')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
const version = versionArg || pkg.version

if (!version) throw new Error('release-notes requires a version')

const changelogPath = join(ROOT, 'CHANGELOG.md')
let notes = `Hyprmnesia ${version}\n`

if (existsSync(changelogPath)) {
  const changelog = readFileSync(changelogPath, 'utf8')
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+/.test(line) && line.includes(version))
  if (start >= 0) {
    const next = lines.findIndex((line, index) => index > start && /^##\s+/.test(line))
    notes = lines
      .slice(start, next >= 0 ? next : undefined)
      .join('\n')
      .trim()
  }
}

mkdirSync(join(ROOT, 'artifacts'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'RELEASE_NOTES.md'), `${notes}\n`)
console.log(`wrote release notes for ${version}`)
