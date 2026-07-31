import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml, parseDocument as parseYamlDocument, isMap, isScalar } from 'yaml'
import type { YAMLMap } from 'yaml'

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const GLOBAL_CONFIG_PATH = join(HERMES_HOME, 'config.yaml')

/**
 * Read the global Hermes model config (~/.hermes/config.yaml). Used to detect
 * when a profile-level override would be redundant — i.e. the user picked the
 * SAME model/provider that the global already provides — so we can drop the
 * profile override entirely and let inheritance work.
 *
 * Why this matters: at the global level Hermes ties `provider: custom` to
 * `base_url` + `api_key`. If a profile sets `provider: custom` WITHOUT also
 * supplying `base_url`, Hermes treats it as a partial override and falls
 * back to a different endpoint (typically OpenRouter, picked up from env).
 * The cleanest UX is "if you're not actually changing anything, don't write
 * an override". Profiles can also carry an explicit base_url when they need a
 * different provider endpoint.
 */
function readGlobalModelConfig(): { model: string | null, provider: string | null, base_url: string | null } {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return { model: null, provider: null, base_url: null }
  try {
    const cfg = parseYaml(readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) as {
      model?: { default?: unknown, provider?: unknown, base_url?: unknown }
    } | null
    return {
      model: typeof cfg?.model?.default === 'string' ? cfg.model.default : null,
      provider: typeof cfg?.model?.provider === 'string' ? cfg.model.provider : null,
      base_url: typeof cfg?.model?.base_url === 'string' ? cfg.model.base_url : null
    }
  } catch {
    return { model: null, provider: null, base_url: null }
  }
}

/* Read the FULL `model:` block from ~/.hermes/config.yaml — default,
   provider, base_url, api_key. Hermes treats each profile's config.yaml as
   self-contained (NO inheritance between profile and global) so to make a
   profile "use the global model" we have to physically copy the four fields
   into the profile's config. Returns null when the global has no `model:`
   block at all (very unusual but handled). */
export interface GlobalModelBlock {
  default: string | null
  provider: string | null
  base_url: string | null
  api_key: string | null
}
export function readGlobalModelBlock(): GlobalModelBlock | null {
  if (!existsSync(GLOBAL_CONFIG_PATH)) return null
  try {
    const cfg = parseYaml(readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) as {
      model?: {
        default?: unknown
        provider?: unknown
        base_url?: unknown
        api_key?: unknown
      }
    } | null
    if (!cfg?.model) return null
    const m = cfg.model
    return {
      default: typeof m.default === 'string' ? m.default : null,
      provider: typeof m.provider === 'string' ? m.provider : null,
      base_url: typeof m.base_url === 'string' ? m.base_url : null,
      api_key: typeof m.api_key === 'string' ? m.api_key : null
    }
  } catch {
    return null
  }
}

export interface ProfileConfigSlice {
  /** model.default — the model string Hermes resolves through its model registry. */
  model: string | null
  /** model.provider — the inference provider (anthropic, openai, custom, etc.). */
  provider: string | null
  /** model.base_url — an optional profile-specific provider endpoint. */
  base_url: string | null
  /** command_allowlist — list of dangerous-pattern descriptions pre-approved without prompting. */
  allowlist: string[]
  /** name — optional display name/callsign for the profile (used by war-room) */
  name: string | null
}

function configPath(profileDir: string): string {
  return join(profileDir, 'config.yaml')
}

export function readProfileConfig(profileDir: string): ProfileConfigSlice {
  const path = configPath(profileDir)
  if (!existsSync(path)) return { model: null, provider: null, base_url: null, allowlist: [], name: null }
  try {
    const raw = readFileSync(path, 'utf8')
    const cfg = parseYaml(raw) as {
      model?: { default?: unknown, provider?: unknown, base_url?: unknown }
      command_allowlist?: unknown
      name?: unknown
    } | null
    const modelDefault = cfg?.model?.default
    const provider = cfg?.model?.provider
    const baseUrl = cfg?.model?.base_url
    const name = cfg?.name
    const list = Array.isArray(cfg?.command_allowlist) ? cfg.command_allowlist : []
    return {
      model: typeof modelDefault === 'string' ? modelDefault : null,
      provider: typeof provider === 'string' ? provider : null,
      base_url: typeof baseUrl === 'string' ? baseUrl.trim() : null,
      name: typeof name === 'string' ? name.trim() : null,
      allowlist: list.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    return { model: null, provider: null, base_url: null, allowlist: [], name: null }
  }
}

export interface ProfileConfigPatch {
  model?: string | null
  provider?: string | null
  base_url?: string | null
  allowlist?: string[]
  name?: string | null
  /** When true, copy the global Hermes `model:` block (default, provider,
   *  base_url, api_key) into this profile's config, overwriting any prior
   *  override. Hermes profiles are NOT inherit-on-miss — they fully shadow
   *  the global — so the only way to "use global" is to physically mirror
   *  the values into the profile. `model` / `provider` from the same patch
   *  are ignored when this flag is true. */
  inheritGlobalModel?: boolean
}

/**
 * Atomically patch select fields of a profile's config.yaml. Uses the YAML
 * Document API so we preserve comments and the rest of the file untouched.
 */
export function writeProfileConfig(profileDir: string, patch: ProfileConfigPatch): void {
  const path = configPath(profileDir)
  /* Fresh hires (hermes profile create without --clone) ship without a
     config.yaml. Start from an empty document so the first patch creates
     the file rather than failing. */
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const doc = parseYamlDocument(raw)

  /* Inherit-from-global: physically copy the global `model:` block into the
     profile so Hermes sees explicit values. Runs FIRST so the per-field
     `model`/`provider` patch logic below would just be redundant. */
  if (patch.inheritGlobalModel) {
    const global = readGlobalModelBlock()
    if (global) {
      doc.set('model', {
        ...(global.default !== null ? { default: global.default } : {}),
        ...(global.provider !== null ? { provider: global.provider } : {}),
        ...(global.base_url !== null ? { base_url: global.base_url } : {}),
        ...(global.api_key !== null ? { api_key: global.api_key } : {})
      })
    } else {
      /* Global has no model block — nothing to copy. Strip any profile-level
         override so we don't keep a stale value. */
      if (doc.has('model')) doc.delete('model')
    }
  } else if ('model' in patch || 'provider' in patch || 'base_url' in patch) {
    /* If `model:` exists but is a scalar/sequence (malformed user config),
       refuse to silently overwrite. Otherwise rely on setIn/deleteIn —
       they create the intermediate map for fresh/empty documents and
       leave existing maps intact, which avoids the brittle "create empty
       object then re-fetch as YAMLMap" dance. */
    const existing = doc.get('model', true) as YAMLMap | undefined | null
    if (existing != null && !isMap(existing)) {
      throw new Error('model: section in config.yaml is not a mapping')
    }
    /* Inheritance shortcut: if the value being set equals the global, treat
       it as a clear (drop the override). Stops the user from accidentally
       writing `provider: custom` at the profile level without `base_url`,
       which detaches the provider from its global base_url + api_key.
       See `readGlobalModelConfig` doc for the full rationale. */
    const globalModel = readGlobalModelConfig()
    const trim = (v: string | null | undefined) =>
      typeof v === 'string' ? v.trim() : v
    const existingBaseUrl = doc.getIn(['model', 'base_url'])
    let effectiveBaseUrl = typeof existingBaseUrl === 'string' ? existingBaseUrl.trim() : null
    if ('base_url' in patch) {
      const v = trim(patch.base_url)
      const matchesGlobal = !!v && v === globalModel.base_url
      if (!v || matchesGlobal) {
        if (doc.hasIn(['model', 'base_url'])) doc.deleteIn(['model', 'base_url'])
        effectiveBaseUrl = null
      } else {
        doc.setIn(['model', 'base_url'], v)
        effectiveBaseUrl = v
      }
    }
    const hasEndpointOverride = !!effectiveBaseUrl && effectiveBaseUrl !== globalModel.base_url
    if ('model' in patch) {
      const v = trim(patch.model)
      const matchesGlobal = !!v && v === globalModel.model && !hasEndpointOverride
      if (!v || matchesGlobal) {
        if (doc.hasIn(['model', 'default'])) doc.deleteIn(['model', 'default'])
      } else {
        doc.setIn(['model', 'default'], v)
      }
    }
    if ('provider' in patch) {
      const v = trim(patch.provider)
      const matchesGlobal = !!v && v === globalModel.provider && !hasEndpointOverride
      if (!v || matchesGlobal) {
        if (doc.hasIn(['model', 'provider'])) doc.deleteIn(['model', 'provider'])
      } else {
        doc.setIn(['model', 'provider'], v)
      }
    }
    /* If after the above edits the `model:` map is empty, drop the empty
       wrapper too so the file stays minimal and inheritance is unambiguous. */
    const after = doc.get('model', true) as YAMLMap | undefined | null
    if (after && isMap(after) && after.items.length === 0) {
      doc.delete('model')
    }
  }

  if (Array.isArray(patch.allowlist)) {
    const cleaned = [...new Set(patch.allowlist.filter(s => typeof s === 'string' && s.trim() !== ''))]
    doc.set('command_allowlist', cleaned)
  }

  if ('name' in patch) {
    if (patch.name === null || (typeof patch.name === 'string' && patch.name.trim() === '')) {
      if (doc.has('name')) doc.delete('name')
    } else if (typeof patch.name === 'string') {
      doc.set('name', patch.name.trim())
    }
  }

  // Defensive: if the resulting `command_allowlist` came out as something
  // other than a sequence (e.g. preserved scalar from an oddly-formatted
  // file), normalise it.
  const al = doc.get('command_allowlist', true)
  if (al && !Array.isArray((al as { items?: unknown[] }).items) && isScalar(al)) {
    doc.set('command_allowlist', [])
  }

  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, doc.toString(), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch { /* ignore */ }
    throw e
  }
}
