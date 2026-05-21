import type { Key } from 'ink'
import type { Dispatch, SetStateAction } from 'react'
import { type Config, saveConfig } from '../config'
import {
  coerceEditedValue,
  getSettingValue,
  nextFieldValue,
  setSettingValue,
  settingsFields,
} from './SettingsPanel'

export interface SettingsKeyContext {
  config: Config
  selected: number
  setSelected: Dispatch<SetStateAction<number>>
  setConfig: Dispatch<SetStateAction<Config>>
  setMessage: Dispatch<SetStateAction<string>>
  editingValue: string | undefined
  setEditingValue: Dispatch<SetStateAction<string | undefined>>
  onApply: () => void
  onReload: () => void
  onClose: () => void
  onOpenLogs: () => void
  onExit: () => void
}

export function handleSettingsKey(input: string, key: Key, ctx: SettingsKeyContext): void {
  const fields = settingsFields(ctx.config)
  const field = fields[ctx.selected]
  if (!field) return

  if (key.ctrl && input === 'c') {
    ctx.onExit()
    return
  }

  const saveNext = (next: Config, message = 'saved config.yaml; restart daemon to apply') => {
    ctx.setConfig(next)
    saveConfig(next)
    ctx.setMessage(message)
  }

  if (ctx.editingValue !== undefined) {
    if (key.return) {
      const nextValue = coerceEditedValue(field, ctx.editingValue)
      if (nextValue !== undefined) saveNext(setSettingValue(ctx.config, field.path, nextValue))
      ctx.setEditingValue(undefined)
    } else if (key.escape) {
      ctx.setEditingValue(undefined)
    } else if (key.backspace || key.delete) {
      ctx.setEditingValue((value) => value?.slice(0, -1) ?? '')
    } else if (key.ctrl && input === 'u') {
      ctx.setEditingValue('')
    } else if (input && !key.ctrl && !key.meta) {
      ctx.setEditingValue((value) => `${value ?? ''}${input}`)
    }
    return
  }

  if (input === 'e') {
    ctx.onExit()
  } else if (key.escape || input === 'c') {
    ctx.onClose()
  } else if (input === 'l') {
    ctx.onOpenLogs()
  } else if (key.upArrow) {
    ctx.setSelected((i) => Math.max(0, i - 1))
  } else if (key.downArrow) {
    ctx.setSelected((i) => Math.min(fields.length - 1, i + 1))
  } else if (key.leftArrow || key.rightArrow) {
    const current = getSettingValue(ctx.config, field.path)
    const direction = key.leftArrow ? -1 : 1
    saveNext(setSettingValue(ctx.config, field.path, nextFieldValue(field, current, direction)))
  } else if (key.return || input === ' ') {
    const current = getSettingValue(ctx.config, field.path)
    if (field.kind === 'text' || field.kind === 'number') {
      ctx.setEditingValue(String(current ?? ''))
    } else {
      saveNext(setSettingValue(ctx.config, field.path, nextFieldValue(field, current, 1)))
    }
  } else if (input === 'a') {
    ctx.onApply()
  } else if (input === 'r') {
    ctx.onReload()
  }
}
