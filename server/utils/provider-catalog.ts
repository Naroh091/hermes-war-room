export interface ProviderModelDefinition {
  model_id: string
  context_window: number
  pricing_usd_per_million_tokens: {
    input: number
    output: number
    cache_read: number
    cache_write: number | null
  }
  input_modalities: string[]
  thinking: string[]
}

export interface ProviderEndpointDefinition {
  region: string
  openai_base_url: string
  anthropic_base_url: string
  docs_root: string
}

export interface ProviderCatalogEntry {
  id: string
  label: string
  model_id: string
  model_ids: string[]
  models: ProviderModelDefinition[]
  endpoints: ProviderEndpointDefinition[]
}

export const BUILTIN_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'minimax',
    label: 'MiniMax',
    model_id: 'MiniMax-M3',
    model_ids: ['MiniMax-M3', 'MiniMax-M2.7'],
    models: [
      {
        model_id: 'MiniMax-M3',
        context_window: 1000000,
        pricing_usd_per_million_tokens: {
          input: 0.6,
          output: 2.4,
          cache_read: 0.12,
          cache_write: null
        },
        input_modalities: ['text', 'image', 'video'],
        thinking: ['adaptive', 'disabled']
      },
      {
        model_id: 'MiniMax-M2.7',
        context_window: 204800,
        pricing_usd_per_million_tokens: {
          input: 0.3,
          output: 1.2,
          cache_read: 0.06,
          cache_write: 0.375
        },
        input_modalities: ['text'],
        thinking: ['always_on']
      }
    ],
    endpoints: [
      {
        region: 'global_en',
        openai_base_url: 'https://api.minimax.io/v1',
        anthropic_base_url: 'https://api.minimax.io/anthropic',
        docs_root: 'https://platform.minimax.io/docs'
      },
      {
        region: 'cn_zh',
        openai_base_url: 'https://api.minimaxi.com/v1',
        anthropic_base_url: 'https://api.minimaxi.com/anthropic',
        docs_root: 'https://platform.minimaxi.com/docs'
      }
    ]
  }
]
