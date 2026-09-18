import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import {
  BUILTIN_PROVIDER_CATALOG,
  type ProviderEndpointDefinition,
  type ProviderModelDefinition
} from '../utils/provider-catalog'

interface CatalogModel {
  id: string
  description?: string
}
interface CatalogProvider {
  metadata?: { display_name?: string, note?: string }
  models?: CatalogModel[]
}
interface Catalog {
  version?: number
  updated_at?: string
  providers?: Record<string, CatalogProvider>
}

interface ModelOption {
  id: string
  provider: string
  description: string
  recommended: boolean
  free: boolean
  context_window?: number
  pricing_usd_per_million_tokens?: ProviderModelDefinition['pricing_usd_per_million_tokens']
  input_modalities?: string[]
  thinking?: string[]
}

interface ProviderOption {
  id: string
  label: string
  count: number
  endpoints: ProviderEndpointDefinition[]
}

interface ModelCatalogResponse {
  updatedAt: string | null
  providers: ProviderOption[]
  models: ModelOption[]
}

interface HermesConfig {
  model?: {
    default?: string
    provider?: string
    base_url?: string
  }
  providers?: Record<string, {
    base_url?: string
    models?: unknown
    default?: string
  }>
}

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes')
const CATALOG_PATH = join(HERMES_HOME, 'cache', 'model_catalog.json')
const CONFIG_PATH = join(HERMES_HOME, 'config.yaml')

let cached: { catalogMtimeMs: number, configMtimeMs: number, payload: ModelCatalogResponse } | null = null

function loadCatalog(): Catalog | null {
  if (!existsSync(CATALOG_PATH)) return null
  try {
    return JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as Catalog
  } catch {
    return null
  }
}

function loadHermesConfig(): HermesConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    return parseYaml(readFileSync(CONFIG_PATH, 'utf8')) as HermesConfig
  } catch {
    return null
  }
}

const FALLBACK_PROVIDERS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  custom: 'Custom (base_url)',
  minimax: 'MiniMax'
}

const BUILTIN_BY_ID = new Map(BUILTIN_PROVIDER_CATALOG.map(provider => [provider.id, provider]))

function builtinEndpoints(providerId: string): ProviderEndpointDefinition[] {
  return (BUILTIN_BY_ID.get(providerId)?.endpoints ?? []).map(endpoint => ({ ...endpoint }))
}

function mergeEndpoints(
  current: ProviderEndpointDefinition[],
  additional: ProviderEndpointDefinition[]
): ProviderEndpointDefinition[] {
  const seen = new Set<string>()
  const merged: ProviderEndpointDefinition[] = []
  for (const endpoint of [...current, ...additional]) {
    const key = [
      endpoint.region,
      endpoint.openai_base_url,
      endpoint.anthropic_base_url,
      endpoint.docs_root
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    merged.push({ ...endpoint })
  }
  return merged
}

function extractModelIds(raw: unknown): string[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    const out: string[] = []
    for (const entry of raw) {
      if (typeof entry === 'string') out.push(entry)
      else if (entry && typeof entry === 'object' && 'id' in entry && typeof (entry as { id: unknown }).id === 'string') {
        out.push((entry as { id: string }).id)
      }
    }
    return out
  }
  if (typeof raw === 'object') return Object.keys(raw as Record<string, unknown>)
  return []
}

function build(catalog: Catalog | null, config: HermesConfig | null): ModelCatalogResponse {
  const providers: ProviderOption[] = []
  const models: ModelOption[] = []
  const modelKey = (m: { id: string, provider: string }) => m.provider + '::' + m.id
  const modelKeys = new Set<string>()

  const ensureProvider = (id: string, label?: string, endpoints = builtinEndpoints(id)) => {
    const existing = providers.find(provider => provider.id === id)
    if (existing) {
      if (label && existing.label === id) existing.label = label
      existing.endpoints = mergeEndpoints(existing.endpoints, endpoints)
      return existing
    }
    const provider: ProviderOption = {
      id,
      label: label ?? FALLBACK_PROVIDERS[id] ?? id,
      count: 0,
      endpoints
    }
    providers.push(provider)
    return provider
  }

  const addModel = (option: ModelOption, countProvider = true): boolean => {
    const key = modelKey(option)
    if (modelKeys.has(key)) return false
    models.push(option)
    modelKeys.add(key)
    if (countProvider) {
      const provider = providers.find(item => item.id === option.provider)
      if (provider) provider.count += 1
    }
    return true
  }

  for (const [pid, body] of Object.entries(catalog?.providers ?? {})) {
    const list = Array.isArray(body?.models) ? body.models : []
    const provider = ensureProvider(pid, body?.metadata?.display_name ?? pid)
    provider.count += list.length
    for (const m of list) {
      if (!m?.id) continue
      const desc = (m.description ?? '').toLowerCase()
      addModel({
        id: m.id,
        provider: pid,
        description: m.description ?? '',
        recommended: desc.includes('recommended'),
        free: desc.includes('free')
      }, false)
    }
  }

  for (const builtin of BUILTIN_PROVIDER_CATALOG) {
    const provider = ensureProvider(builtin.id, builtin.label, builtin.endpoints)
    for (const model of builtin.models) {
      const option: ModelOption = {
        id: model.model_id,
        provider: builtin.id,
        description: model.model_id === builtin.model_id ? 'configured default' : 'built-in',
        recommended: model.model_id === builtin.model_id,
        free: false,
        context_window: model.context_window,
        pricing_usd_per_million_tokens: model.pricing_usd_per_million_tokens,
        input_modalities: model.input_modalities,
        thinking: model.thinking
      }
      if (!addModel(option)) {
        const existing = models.find(item => modelKey(item) === modelKey(option))
        if (existing) {
          existing.context_window = option.context_window
          existing.pricing_usd_per_million_tokens = option.pricing_usd_per_million_tokens
          existing.input_modalities = option.input_modalities
          existing.thinking = option.thinking
          existing.recommended = option.recommended
        }
      }
    }
    if (provider.count === 0) provider.count = builtin.models.length
  }

  if (config?.model?.default && config.model.provider) {
    const pid = config.model.provider
    ensureProvider(pid)
    addModel({
      id: config.model.default,
      provider: pid,
      description: 'configured default',
      recommended: false,
      free: false
    })
  }

  for (const [pid, body] of Object.entries(config?.providers ?? {})) {
    if (!body || typeof body !== 'object') continue
    ensureProvider(pid)
    const ids = extractModelIds(body.models)
    if (body.default && !ids.includes(body.default)) ids.unshift(body.default)
    for (const id of ids) {
      addModel({
        id,
        provider: pid,
        description: 'configured',
        recommended: false,
        free: false
      })
    }
  }

  for (const [pid, label] of Object.entries(FALLBACK_PROVIDERS)) {
    ensureProvider(pid, label)
  }

  models.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider)
    return a.id.localeCompare(b.id)
  })

  return {
    updatedAt: catalog?.updated_at ?? null,
    providers,
    models
  }
}

export default defineEventHandler((): ModelCatalogResponse => {
  const catalogMtimeMs = existsSync(CATALOG_PATH) ? statSync(CATALOG_PATH).mtimeMs : 0
  const configMtimeMs = existsSync(CONFIG_PATH) ? statSync(CONFIG_PATH).mtimeMs : 0

  if (cached && cached.catalogMtimeMs === catalogMtimeMs && cached.configMtimeMs === configMtimeMs) {
    return cached.payload
  }

  const catalog = loadCatalog()
  const config = loadHermesConfig()

  const payload = build(catalog, config)
  cached = { catalogMtimeMs, configMtimeMs, payload }
  return payload
})
