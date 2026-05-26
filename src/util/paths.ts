import { homedir } from 'node:os'
import { join } from 'node:path'

export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1))
  }
  return p
}

const _defaultDataDir = () => join(homedir(), '.hyprmnesia', 'data')
export const defaultConfigPath = () => join(homedir(), '.hyprmnesia', 'config.yaml')
export const legacyConfigPath = () => join(homedir(), '.hyprmnesia', 'config.json')
const _enginesDir = () => join(homedir(), '.hyprmnesia', 'engines')
export const defaultDbPath = () => join(homedir(), '.hyprmnesia', 'index.db')
export const defaultWaylandTokenPath = () => join(homedir(), '.hyprmnesia', 'wayland-portal-token')
