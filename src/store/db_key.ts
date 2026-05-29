// Resolves the 256-bit master key for the encrypted index DB (#12). The key
// lives in the OS keychain (via src/util/secret_store) so the background daemon
// can re-open the DB on restart without prompting. Generated on first use.

import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createSecretStore, type SecretStore } from '../util/secret_store'
import { deriveBlobKey } from './blob_crypto'

const KEY_BYTES = 32

function indexKeyStore(): SecretStore {
  const base = join(homedir(), '.hyprmnesia')
  return createSecretStore({
    service: 'hyprmnesia-index-key',
    label: 'Hyprmnesia index DB key',
    attributes: ['service', 'hyprmnesia', 'name', 'index-key'],
    filePath: join(base, 'index-key'),
    dpapiPath: join(base, 'index-key.dpapi'),
  })
}

// Returns the raw key, generating and persisting it on first use.
export function getOrCreateIndexKey(): Buffer {
  const store = indexKeyStore()
  const existing = store.read()
  if (existing) {
    const buf = Buffer.from(existing.trim(), 'hex')
    if (buf.length === KEY_BYTES) return buf
  }
  const key = randomBytes(KEY_BYTES)
  const backend = store.write(key.toString('hex'))
  if (backend === 'file') {
    console.warn(
      '[hyprmnesia] no OS keychain available; the index-DB key is stored in a plaintext ' +
        'file next to the database. At-rest protection is weakened — install a Secret Service ' +
        '(e.g. gnome-keyring) for full protection.',
    )
  }
  return key
}

// Reads the existing master key from the keychain WITHOUT creating one. Used by
// readers (MCP, replay) and when opening data that may already be encrypted even
// if the corresponding flag is now off — so existing encrypted data stays
// readable. Returns undefined when no key has ever been created.
export function readIndexKey(): Buffer | undefined {
  const existing = indexKeyStore().read()
  if (!existing) return undefined
  const buf = Buffer.from(existing.trim(), 'hex')
  return buf.length === KEY_BYTES ? buf : undefined
}

// The blob subkey derived from the existing master key, or undefined when none
// exists. HKDF subkey of the index master key, so blobs reuse the single
// OS-keychain entry without sharing raw key material.
export function readBlobKey(): Buffer | undefined {
  const master = readIndexKey()
  return master ? deriveBlobKey(master) : undefined
}
