import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { parse, stringify } from 'yaml'

// Run with Node 22: node --experimental-strip-types --test tests/models.test.mjs.
// Resolve Nuxt's extensionless TS imports without starting the app or Hermes.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../../../utils/db') {
      return { url: 'test:db', shortCircuit: true }
    }
    if (specifier === '../../../utils/orchestrator-acp') {
      return { url: 'test:acp', shortCircuit: true }
    }
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (specifier.startsWith('.')) return nextResolve(specifier + '.ts', context)
      throw error
    }
  },
  load(url, context, nextLoad) {
    if (url === 'test:db') {
      return { format: 'module', shortCircuit: true, source: 'export const useDb = () => ({ prepare: () => ({ get: () => ({ hermes_dir: globalThis.profileDir }) }) })' }
    }
    if (url === 'test:acp') {
      return { format: 'module', shortCircuit: true, source: 'export const restart = slug => { globalThis.restartedSlug = slug; return { killed: true } }' }
    }
    return nextLoad(url, context)
  }
})

mkdirSync('node_modules/.cache', { recursive: true })
const home = mkdtempSync(join(process.cwd(), 'node_modules/.cache/models-test-'))
process.env.HERMES_HOME = home
mkdirSync(join(home, 'cache'))
globalThis.defineEventHandler = handler => handler
globalThis.getRouterParam = event => event.slug
globalThis.readBody = async event => JSON.parse(event.body)
globalThis.createError = data => Object.assign(new Error(data.statusMessage), data)
const getModels = (await import('../server/api/models.get.ts')).default
const putConfig = (await import('../server/api/profiles/[slug]/config.put.ts')).default
const { BUILTIN_PROVIDER_CATALOG } = await import('../server/utils/provider-catalog.ts')

const ids = (result, provider) => result.models.filter(m => m.provider === provider).map(m => m.id)

test('fresh catalog recommends Flash first with current direct metadata', () => {
  const result = JSON.parse(JSON.stringify(getModels()))
  assert.deepEqual(ids(result, 'minimax'), ['MiniMax-M3.1-Flash', 'MiniMax-M3'])
  const flash = result.models.find(m => m.id === 'MiniMax-M3.1-Flash')
  assert.equal(flash.recommended, true)
  assert.equal(flash.context_window, 1000000)
  assert.equal(flash.max_output_tokens, 524288)
  assert.deepEqual(flash.thinking, ['adaptive'])
  assert.deepEqual(flash.input_modalities, ['text', 'image', 'video'])
  assert.deepEqual(flash.pricing_usd_per_million_tokens, { input: 0.15, output: 0.6, cache_read: 0.015, cache_write: null })
  assert.equal(result.models.find(m => m.id === 'MiniMax-M3').recommended, false)
})

test('cached choices are filtered without dropping configured IDs, media, or other models', () => {
  const models = values => values.map(id => ({ id, description: 'recommended' }))
  writeFileSync(join(home, 'cache/model_catalog.json'), JSON.stringify({ providers: {
    minimax: { models: models(['MiniMax-M2.7', 'MiniMax-M2', 'MiniMax-Text-01', 'abab6.5-chat', 'MiniMax-M3', 'MiniMax-M3', 'speech-2.8-hd', 'image-01']) },
    openrouter: { models: models(['minimax/minimax-m2.7', 'minimax/minimax-m3', 'minimax/minimax-m3.1-flash', 'minimax/minimax-m3.1-flash:free', 'other/model']) },
    opencode: { models: models(['minimax-m2.7', 'minimax-m3', 'minimax-m3.1-flash-free']) },
    custom: { models: models(['MiniMax-M2.1']) },
    other: { models: models(['unrelated-model']) }
  } }))
  writeFileSync(join(home, 'config.yaml'), stringify({
    model: { default: 'MiniMax-M2.7', provider: 'minimax' },
    providers: { minimax: { models: ['legacy-personal-model'] }, custom: { default: 'my-model' } }
  }))
  const result = JSON.parse(JSON.stringify(getModels()))
  assert.deepEqual(ids(result, 'minimax').filter(id => id.startsWith('MiniMax-')), ['MiniMax-M3.1-Flash', 'MiniMax-M2.7', 'MiniMax-M3'])
  assert(ids(result, 'minimax').includes('legacy-personal-model'))
  assert(ids(result, 'minimax').includes('speech-2.8-hd'))
  assert(ids(result, 'minimax').includes('image-01'))
  assert.deepEqual(ids(result, 'openrouter').filter(id => id.startsWith('minimax/')), ['minimax/minimax-m3.1-flash:free', 'minimax/minimax-m3'])
  assert.deepEqual(ids(result, 'opencode'), ['minimax-m3.1-flash-free', 'minimax-m3'])
  assert(ids(result, 'openrouter').includes('other/model'))
  assert.deepEqual(ids(result, 'other'), ['unrelated-model'])
  assert(ids(result, 'custom').includes('MiniMax-M2.1'))
  assert(ids(result, 'custom').includes('my-model'))
  for (const provider of result.providers) assert.equal(provider.count, ids(result, provider.id).length)
  const gatewayFlash = result.models.find(m => m.id === 'minimax/minimax-m3.1-flash:free')
  assert.equal(gatewayFlash.context_window, undefined)
  assert.equal(gatewayFlash.pricing_usd_per_million_tokens, undefined)
})

test('profile API serializes selected models and all direct endpoints for the Hermes consumer', async () => {
  const endpoints = BUILTIN_PROVIDER_CATALOG[0].endpoints.flatMap(e => [e.openai_base_url, e.anthropic_base_url])
  for (const baseUrl of endpoints) {
    for (const model of ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'personal-model']) {
      globalThis.profileDir = mkdtempSync(join(home, 'profile-'))
      const preserved = { thinking: { type: 'adaptive' }, output_config: { effort: 'high' }, media: { image: 'unchanged' } }
      writeFileSync(join(globalThis.profileDir, 'config.yaml'), stringify(preserved))
      const response = await putConfig({ slug: 'fixture', body: JSON.stringify({ model, provider: 'minimax', base_url: baseUrl }) })
      assert.equal(response.model, model)
      assert.equal(response.base_url, baseUrl)
      assert.equal(response.acpRestarted, true)
      assert.equal(globalThis.restartedSlug, 'fixture')
      const serialized = parse(readFileSync(join(globalThis.profileDir, 'config.yaml'), 'utf8'))
      assert.deepEqual(serialized.model, { default: model, provider: 'minimax', base_url: baseUrl })
      for (const [key, value] of Object.entries(preserved)) assert.deepEqual(serialized[key], value)
    }
  }
})

test('saved gateway and custom routes are serialized without model substitution', async () => {
  for (const [provider, model, baseUrl] of [
    ['openrouter', 'minimax/minimax-m2.7', 'https://openrouter.ai/api/v1'],
    ['custom', 'personal-model', 'https://example.invalid/v1']
  ]) {
    globalThis.profileDir = mkdtempSync(join(home, 'profile-'))
    await putConfig({ slug: 'fixture', body: JSON.stringify({ model, provider, base_url: baseUrl }) })
    assert.deepEqual(parse(readFileSync(join(globalThis.profileDir, 'config.yaml'), 'utf8')).model, {
      default: model, provider, base_url: baseUrl
    })
  }
})

test('both profile pickers retain current legacy and typed IDs absent from the catalog', () => {
  for (const component of ['HireProfileModal', 'RetrainProfileModal']) {
    const source = readFileSync(new URL(`../app/components/${component}.vue`, import.meta.url), 'utf8')
    const computed = source.match(/const modelMenuItems = computed<ModelMenuItem\[\]>\(\(\) => \{[\s\S]*?\n\}\)/)?.[0]
    assert(computed, `${component} model picker must be exercised`)
    const js = ts.transpileModule(computed + '\nmodelMenuItems', { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText
    for (const current of ['MiniMax-M2.7', 'personal-model']) {
      const items = runInNewContext(js, {
        computed: callback => callback(),
        provider: { value: 'minimax' },
        model: { value: current },
        providerCatalog: { value: [{ id: 'minimax', count: 2 }] },
        modelCatalog: { value: [
          { id: 'MiniMax-M3.1-Flash', provider: 'minimax', recommended: true, free: false },
          { id: 'MiniMax-M3', provider: 'minimax', recommended: false, free: false }
        ] }
      })
      assert.equal(items[0].value, current)
      assert.equal(items[1].value, 'MiniMax-M3.1-Flash')
    }
  }
})

test('global inheritance preserves a saved legacy model and custom endpoint', async () => {
  const saved = { default: 'MiniMax-M2.7', provider: 'custom', base_url: 'https://example.invalid/v1' }
  writeFileSync(join(home, 'config.yaml'), stringify({ model: saved }))
  globalThis.profileDir = mkdtempSync(join(home, 'profile-'))
  await putConfig({ slug: 'fixture', body: JSON.stringify({ inheritGlobalModel: true }) })
  assert.deepEqual(parse(readFileSync(join(globalThis.profileDir, 'config.yaml'), 'utf8')).model, saved)
})
