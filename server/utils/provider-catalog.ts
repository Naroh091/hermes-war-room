export interface ProviderModelDefinition {
  model_id: string
  context_window: number
  max_output_tokens?: number
  pricing_note?: string
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

// Direct API metadata: https://platform.minimax.io/docs/guides/models-intro
// Pricing: https://platform.minimax.io/docs/guides/pricing-paygo
export const BUILTIN_PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: 'minimax',
    label: 'MiniMax',
    model_id: 'MiniMax-M3.1-Flash',
    model_ids: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
    models: [
      {
        model_id: 'MiniMax-M3.1-Flash',
        context_window: 1000000,
        max_output_tokens: 524288,
        pricing_usd_per_million_tokens: {
          input: 0.15,
          output: 0.6,
          cache_read: 0.015,
          cache_write: null
        },
        input_modalities: ['text', 'image', 'video'],
        thinking: ['adaptive']
      },
      {
        model_id: 'MiniMax-M3',
        context_window: 1000000,
        pricing_usd_per_million_tokens: {
          input: 0.3,
          output: 1.2,
          cache_read: 0.06,
          cache_write: null
        },
        pricing_note: 'Standard up to 512k input tokens; above 512k: input $0.60, output $2.40, cache read $0.12 per million tokens. Priority costs 1.5x standard.',
        input_modalities: ['text', 'image', 'video'],
        thinking: ['adaptive', 'disabled']
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
