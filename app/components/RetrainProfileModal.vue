<script setup lang="ts">
import type { Profile } from '~/types/profile'

interface Skill {
  name: string
  category: string | null
  description: string | null
  source: 'builtin' | 'global' | 'profile'
  enabled: boolean
}

interface Tool {
  name: string
  label: string
  enabled: boolean
}

interface McpServer {
  name: string
  transport: 'http' | 'stdio' | 'unknown'
  endpoint: string
  tools?: unknown
  headerCount: number
}

interface AgentsResponse {
  content: string
  source: 'profile' | 'global' | 'empty'
}

interface ProfileConfigSlice {
  model: string | null
  provider: string | null
  base_url: string | null
  allowlist: string[]
  name: string | null
}

interface ModelOption {
  id: string
  provider: string
  description: string
  recommended: boolean
  free: boolean
}

interface ModelCatalogResponse {
  updatedAt: string | null
  providers: ProviderOption[]
  models: ModelOption[]
}

interface ModelMenuItem {
  label: string
  value: string
  provider: string
  description: string
  recommended: boolean
  free: boolean
}

interface ProviderEndpoint {
  region: string
  openai_base_url: string
  anthropic_base_url: string
  docs_root: string
}

interface ProviderOption {
  id: string
  label: string
  count: number
  endpoints: ProviderEndpoint[]
}

const props = defineProps<{
  open: boolean
  profile: Profile | null
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'fired': [slug: string]
  'renamed': [payload: { oldSlug: string, profile: Profile }]
}>()

const { t } = useI18n()
const toast = useToast()

const NAME_RE = /^[a-z0-9]+$/
const slug = ref('')
const initialSlug = ref('')
const slugValid = computed(() => slug.value === '' || NAME_RE.test(slug.value))

/* "Inherit from global": when true, the profile-level model + provider get
   cleared on save, so Hermes inherits the global `model:` block (which on
   `provider: custom` carries the matching base_url + api_key). Default ON
   when the loaded profile has no explicit override; OFF when it does. */
const inheritGlobal = ref(true)

const skills = ref<Skill[]>([])
const enabledSkills = ref<string[]>([])
const tools = ref<Tool[]>([])
const enabledTools = ref<string[]>([])
const mcpServers = ref<McpServer[]>([])
const soul = ref('')
const initialSoul = ref('')
const agents = ref('')
const initialAgents = ref('')
const agentsSource = ref<AgentsResponse['source']>('empty')
const model = ref('')
const initialModel = ref('')
const provider = ref('')
const initialProvider = ref('')
const baseUrl = ref('')
const initialBaseUrl = ref('')
const allowlist = ref<string[]>([])
const initialAllowlist = ref<string[]>([])
const loading = ref(false)
const submitting = ref(false)
const firing = ref(false)
const confirmFire = ref(false)

const modelCatalog = ref<ModelOption[]>([])
const providerCatalog = ref<ProviderOption[]>([])
const modelCatalogLoaded = ref(false)

const providerMenuItems = computed(() => {
  const items = providerCatalog.value.map(p => ({ label: p.label, value: p.id, count: p.count }))
  /* If the profile already has a provider set that the catalog doesn't know
     about, surface it so it actually shows in the dropdown. */
  const current = provider.value
  if (current && !items.some(i => i.value === current)) {
    items.unshift({ label: current, value: current, count: 0 })
  }
  return items
})

const endpointMenuItems = computed(() => {
  const selectedProvider = providerCatalog.value.find(item => item.id === provider.value)
  const items = (selectedProvider?.endpoints ?? []).flatMap(endpoint => [
    {
      label: endpoint.region + ' / OpenAI-compatible',
      value: endpoint.openai_base_url
    },
    {
      label: endpoint.region + ' / Anthropic-compatible',
      value: endpoint.anthropic_base_url
    }
  ])
  const current = baseUrl.value
  if (current && !items.some(item => item.value === current)) {
    items.unshift({ label: current, value: current })
  }
  return items
})

const modelMenuItems = computed<ModelMenuItem[]>(() => {
  /* Strict filter when a provider is selected: show only that provider's
     models. Custom/self-hosted entries are surfaced via the unshift below
     and via config.yaml ingestion in /api/models, so picking `custom`
     correctly narrows to the actual configured model rather than the full
     soup of every provider. If the selected provider really has no entries
     anywhere (rare — only if the catalog is empty AND config doesn't
     declare it), fall back to the full list so the user can still type. */
  const filterProvider = provider.value
  const providerKnown = !!filterProvider
    && providerCatalog.value.some(p => p.id === filterProvider && p.count > 0)
  const filtered = filterProvider && providerKnown
    ? modelCatalog.value.filter(m => m.provider === filterProvider)
    : modelCatalog.value

  const items: ModelMenuItem[] = filtered.map(m => ({
    label: m.id,
    value: m.id,
    provider: m.provider,
    description: m.description,
    recommended: m.recommended,
    free: m.free
  }))

  /* If the profile is using a model the catalog doesn't list (very common with
     `provider: custom` + a self-hosted id like qwen3.6), inject it as a virtual
     entry tagged "current" so the user can see what's selected. */
  const current = model.value
  if (current && !items.some(i => i.value === current)) {
    items.unshift({
      label: current,
      value: current,
      provider: provider.value || '—',
      description: 'current',
      recommended: false,
      free: false
    })
  }
  return items
})

async function loadModels() {
  if (modelCatalogLoaded.value) return
  try {
    const res = await $fetch<ModelCatalogResponse>('/api/models')
    modelCatalog.value = res.models
    providerCatalog.value = res.providers
  } catch {
    /* catalog optional — input still works as free-text */
  } finally {
    modelCatalogLoaded.value = true
  }
}

const toolsModalOpen = ref(false)
const skillsModalOpen = ref(false)
const mcpModalOpen = ref(false)

const enabledToolLabels = computed(() => {
  const lookup = new Map(tools.value.map(t => [t.name, t.label]))
  return enabledTools.value.map(name => lookup.get(name) ?? name)
})
const enabledSkillLabels = computed(() => enabledSkills.value.slice().sort())
const mcpServerLabels = computed(() => mcpServers.value.map(s => s.name))

const displayName = computed(() => props.profile?.givenName ?? props.profile?.displayName ?? '')

async function loadAll(slug: string) {
  loading.value = true
  try {
    const [skillList, toolList, soulData, mcpData, agentsData, configData] = await Promise.all([
      $fetch<Skill[]>(`/api/profiles/${slug}/skills`).catch((e) => {
        toast.add({ title: t('skills.loadFailed'), description: (e as Error).message, color: 'error' })
        return [] as Skill[]
      }),
      $fetch<Tool[]>(`/api/profiles/${slug}/tools`).catch((e) => {
        toast.add({ title: t('tools.loadFailed'), description: (e as Error).message, color: 'error' })
        return [] as Tool[]
      }),
      $fetch<{ soul: string }>(`/api/profiles/${slug}/soul`).catch((e) => {
        toast.add({ title: t('soul.loadFailed'), description: (e as Error).message, color: 'error' })
        return { soul: '' }
      }),
      $fetch<{ servers: McpServer[] }>(`/api/profiles/${slug}/mcp`).catch((e) => {
        toast.add({ title: t('mcp.loadFailed'), description: (e as Error).message, color: 'error' })
        return { servers: [] as McpServer[] }
      }),
      $fetch<AgentsResponse>(`/api/profiles/${slug}/agents`).catch((e) => {
        toast.add({ title: t('agents.loadFailed'), description: (e as Error).message, color: 'error' })
        return { content: '', source: 'empty' as const }
      }),
      $fetch<ProfileConfigSlice>(`/api/profiles/${slug}/config`).catch((e) => {
        toast.add({ title: t('profileConfig.loadFailed'), description: (e as Error).message, color: 'error' })
        return { model: null, provider: null, base_url: null, allowlist: [] as string[], name: null }
      })
    ])
    skills.value = skillList
    enabledSkills.value = skillList.filter(s => s.enabled).map(s => s.name)
    tools.value = toolList
    enabledTools.value = toolList.filter(t => t.enabled).map(t => t.name)
    soul.value = soulData.soul ?? ''
    initialSoul.value = soul.value
    mcpServers.value = mcpData.servers
    agents.value = agentsData.content
    initialAgents.value = agents.value
    agentsSource.value = agentsData.source
    model.value = configData.model ?? ''
    initialModel.value = model.value
    provider.value = configData.provider ?? ''
    initialProvider.value = provider.value
    baseUrl.value = configData.base_url ?? ''
    initialBaseUrl.value = baseUrl.value
    /* If the profile has neither a model nor a provider, it's currently
       inheriting from the global config — start the toggle ON. Otherwise
       it has explicit overrides; default to OFF so the dropdowns are
       visible and the user can edit. */
    inheritGlobal.value = !configData.model && !configData.provider && !configData.base_url
    allowlist.value = [...configData.allowlist]
    initialAllowlist.value = [...configData.allowlist]
  } finally {
    loading.value = false
  }
}

function onMcpRemoved(name: string) {
  mcpServers.value = mcpServers.value.filter(s => s.name !== name)
}

watch(() => [props.open, props.profile?.slug], ([open, profileSlug]) => {
  if (open && typeof profileSlug === 'string') {
    slug.value = profileSlug
    initialSlug.value = profileSlug
    loadAll(profileSlug)
    loadModels()
  } else if (!open) {
    skills.value = []
    enabledSkills.value = []
    tools.value = []
    enabledTools.value = []
    mcpServers.value = []
    soul.value = ''
    initialSoul.value = ''
    agents.value = ''
    initialAgents.value = ''
    agentsSource.value = 'empty'
    model.value = ''
    initialModel.value = ''
    provider.value = ''
    initialProvider.value = ''
    baseUrl.value = ''
    initialBaseUrl.value = ''
    allowlist.value = []
    initialAllowlist.value = []
    confirmFire.value = false
    toolsModalOpen.value = false
    skillsModalOpen.value = false
    mcpModalOpen.value = false
    slug.value = ''
    initialSlug.value = ''
  }
})

function removeAllowlistEntry(entry: string) {
  allowlist.value = allowlist.value.filter(e => e !== entry)
}
function clearAllowlist() {
  allowlist.value = []
}

async function submit() {
  if (!props.profile) return
  if (!slugValid.value || slug.value.trim() === '') {
    toast.add({ title: t('rename.invalid'), color: 'error' })
    return
  }
  submitting.value = true
  try {
    /* If the slug changed, rename FIRST. All subsequent API calls must use
       the new slug, since the old one no longer exists on disk. */
    let workingSlug = props.profile.slug
    const desiredSlug = slug.value.trim()
    if (desiredSlug !== initialSlug.value) {
      const renamed = await $fetch<Profile>(
        `/api/profiles/${props.profile.slug}/rename`,
        { method: 'POST', body: { newSlug: desiredSlug } }
      )
      workingSlug = renamed.slug
      emit('renamed', { oldSlug: props.profile.slug, profile: renamed })
      toast.add({
        title: t('rename.success', { slug: workingSlug }),
        color: 'primary',
        icon: 'i-lucide-tag'
      })
    }

    const enabledSkillSet = new Set(enabledSkills.value)
    const disabledSkills = skills.value.filter(s => !enabledSkillSet.has(s.name)).map(s => s.name)

    const writes: Promise<unknown>[] = [
      $fetch(`/api/profiles/${workingSlug}/skills`, {
        method: 'PUT',
        body: { disabled: disabledSkills }
      }),
      $fetch(`/api/profiles/${workingSlug}/tools`, {
        method: 'PUT',
        body: { enabled: enabledTools.value }
      })
    ]

    if (soul.value !== initialSoul.value) {
      writes.push($fetch(`/api/profiles/${workingSlug}/soul`, {
        method: 'PUT',
        body: { soul: soul.value }
      }))
    }

    if (agents.value !== initialAgents.value) {
      writes.push($fetch(`/api/profiles/${workingSlug}/agents`, {
        method: 'PUT',
        body: { content: agents.value }
      }))
    }

    /* "Inherit from global" → backend physically copies the global model
       block (default + provider + base_url + api_key) into the profile.
       Hermes profiles are NOT inherit-on-miss — they fully shadow global —
       so we have to mirror the values explicitly. */
    const effectiveModel = inheritGlobal.value ? null : (model.value.trim() || null)
    const effectiveProvider = inheritGlobal.value ? null : (provider.value.trim() || null)
    const effectiveBaseUrl = inheritGlobal.value ? null : (baseUrl.value.trim() || null)
    const modelChanged = !inheritGlobal.value && effectiveModel !== (initialModel.value || null)
    const providerChanged = !inheritGlobal.value && effectiveProvider !== (initialProvider.value || null)
    const baseUrlChanged = !inheritGlobal.value && effectiveBaseUrl !== (initialBaseUrl.value || null)
    const allowlistChanged = JSON.stringify(allowlist.value) !== JSON.stringify(initialAllowlist.value)
    /* Always send inherit when the toggle is ON, even if it was on initially —
       cheap idempotent overwrite that re-syncs the profile to current global
       (covers the case where the user changed global between saves). */
    if (inheritGlobal.value || modelChanged || providerChanged || baseUrlChanged || allowlistChanged) {
      const body: Record<string, unknown> = {}
      if (inheritGlobal.value) {
        body.inheritGlobalModel = true
      } else {
        if (modelChanged) body.model = effectiveModel
        if (providerChanged) body.provider = effectiveProvider
        if (baseUrlChanged) body.base_url = effectiveBaseUrl
      }
      if (allowlistChanged) body.allowlist = allowlist.value
      writes.push($fetch(`/api/profiles/${workingSlug}/config`, {
        method: 'PUT',
        body
      }))
    }

    await Promise.all(writes)

    toast.add({
      title: t('retrain.success'),
      color: 'primary',
      icon: 'i-lucide-graduation-cap'
    })
    emit('update:open', false)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('retrain.failure'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}

async function fire() {
  if (!props.profile || props.profile.isDefault) return
  firing.value = true
  try {
    const slug = props.profile.slug
    const displayName = props.profile.givenName ?? props.profile.displayName
    await $fetch(`/api/profiles/${slug}`, { method: 'DELETE' })
    toast.add({
      title: t('fire.success', { name: displayName }),
      color: 'primary',
      icon: 'i-lucide-user-minus'
    })
    emit('fired', slug)
    emit('update:open', false)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('fire.failure'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    firing.value = false
    confirmFire.value = false
  }
}

const agentsHint = computed(() => {
  if (agentsSource.value === 'global') return t('agents.hintGlobal')
  if (agentsSource.value === 'profile') return t('agents.hintProfile')
  return t('agents.hintEmpty')
})
</script>

<template>
  <UModal
    :open="open"
    :ui="{
      content: 'max-w-6xl',
      overlay: 'bg-[#1c1a14]/40 backdrop-blur-sm'
    }"
    @update:open="emit('update:open', $event)"
  >
    <template #content>
      <div class="dossier">
        <!-- Sash header — same shape as Hire, different stencil + hot color flips to amber accents on the side. -->
        <header class="dossier-head">
          <span class="dossier-cmark dossier-cmark--tl" />
          <span class="dossier-cmark dossier-cmark--tr" />
          <div class="dossier-head-stencil">
            Operative File · Retrain
          </div>
          <h2 class="dossier-title">
            {{ t('retrain.title', { name: displayName }) }}
          </h2>
          <p class="dossier-subtitle">
            {{ t('retrain.subtitle') }}
          </p>
          <button
            type="button"
            class="dossier-close"
            :aria-label="t('common.cancel')"
            @click="emit('update:open', false)"
          >
            <UIcon
              name="i-lucide-x"
              class="size-4"
            />
          </button>
        </header>

        <!-- Scrollable body region — head + foot stay pinned, this scrolls. -->
        <div class="dossier-scroll">
          <!-- Two-column body. -->
          <div class="dossier-grid">
            <!-- LEFT: identity & rules. -->
            <section class="dossier-col">
              <div class="section-rule">
                <UIcon
                  name="i-lucide-id-card"
                  class="size-3.5"
                />
                <span class="section-rule-label">{{ t('retrain.identitySection') }}</span>
                <span class="section-rule-line" />
              </div>

              <UFormField
                :label="t('soul.title')"
                :help="t('soul.hint')"
              >
                <UTextarea
                  v-model="soul"
                  :placeholder="t('soul.placeholder')"
                  :rows="14"
                  :disabled="loading"
                  autoresize
                  spellcheck="false"
                  class="w-full prose-textarea"
                />
              </UFormField>

              <UFormField
                :label="t('agents.title')"
                :help="agentsHint"
              >
                <template
                  v-if="agentsSource === 'global'"
                  #description
                >
                  <UBadge
                    color="warning"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t('agents.inheriting') }}
                  </UBadge>
                </template>
                <UTextarea
                  v-model="agents"
                  :placeholder="t('agents.placeholder')"
                  :rows="14"
                  :disabled="loading"
                  autoresize
                  spellcheck="false"
                  class="w-full prose-textarea"
                />
              </UFormField>
            </section>

            <!-- RIGHT: capabilities. -->
            <section class="dossier-col">
              <div class="section-rule">
                <UIcon
                  name="i-lucide-wrench"
                  class="size-3.5"
                />
                <span class="section-rule-label">{{ t('retrain.capabilitiesSection') }}</span>
                <span class="section-rule-line" />
              </div>

              <!-- Mirror Hire's two-row layout for the elements that exist in
                   both modals. Hire row 1 = slug + cloneFrom; Retrain has no
                   cloneFrom, so slug sits alone full-width. Hire row 2 =
                   provider + model; Retrain matches it 1:1. -->
              <UFormField
                :label="t('rename.label')"
                :help="profile?.isDefault ? t('rename.blockedDefault') : t('rename.help')"
                :error="!slugValid ? t('rename.invalid') : undefined"
              >
                <UInput
                  v-model="slug"
                  :disabled="loading || profile?.isDefault"
                  spellcheck="false"
                  autocomplete="off"
                  class="w-full font-mono"
                />
              </UFormField>

              <!-- Inherit-from-global toggle. When ON, hides provider, model and
                   endpoint controls, then clears the override on save. Default ON when
                   the profile already has no override. -->
              <label class="inherit-toggle">
                <USwitch
                  v-model="inheritGlobal"
                  :disabled="loading"
                />
                <span class="inherit-toggle-text">
                  <span class="inherit-toggle-label">{{ t('profileConfig.inheritGlobal') }}</span>
                  <span class="inherit-toggle-hint">{{ t('profileConfig.inheritGlobalHint') }}</span>
                </span>
              </label>

              <div
                v-if="!inheritGlobal"
                class="field-row field-row--two"
              >
                <UFormField :label="t('profileConfig.provider')">
                  <USelectMenu
                    v-model="provider"
                    :items="providerMenuItems"
                    value-key="value"
                    :placeholder="t('profileConfig.providerPlaceholder')"
                    :search-input="{ placeholder: t('profileConfig.providerPlaceholder') }"
                    create-item="always"
                    :disabled="loading"
                    class="w-full"
                    :ui="{ base: 'font-mono text-xs' }"
                  />
                </UFormField>
                <UFormField :label="t('profileConfig.model')">
                  <USelectMenu
                    v-model="model"
                    :items="modelMenuItems"
                    value-key="value"
                    :placeholder="t('profileConfig.providerPlaceholder')"
                    :search-input="{ placeholder: t('profileConfig.modelSearch') }"
                    :create-item="modelCatalogLoaded ? 'always' : false"
                    :disabled="loading"
                    class="w-full"
                    :ui="{
                      base: 'font-mono text-xs',
                      item: 'gap-2',
                      itemLabel: 'font-mono text-xs'
                    }"
                  >
                    <template #item="{ item }">
                      <span class="model-row">
                        <span class="model-row-id">{{ (item as ModelMenuItem).value }}</span>
                        <span
                          v-if="(item as ModelMenuItem).recommended"
                          class="model-badge model-badge--rec"
                        >{{ t('profileConfig.modelRecommended') }}</span>
                        <span
                          v-else-if="(item as ModelMenuItem).free"
                          class="model-badge model-badge--free"
                        >{{ t('profileConfig.modelFree') }}</span>
                        <span class="model-row-provider">{{ (item as ModelMenuItem).provider }}</span>
                      </span>
                    </template>
                  </USelectMenu>
                </UFormField>
              </div>

              <UFormField
                v-if="!inheritGlobal"
                :label="t('profileConfig.baseUrl')"
                :help="t('profileConfig.baseUrlHint')"
              >
                <USelectMenu
                  v-model="baseUrl"
                  :items="endpointMenuItems"
                  value-key="value"
                  :placeholder="t('profileConfig.baseUrlPlaceholder')"
                  :search-input="{ placeholder: t('profileConfig.baseUrlSearch') }"
                  create-item="always"
                  :disabled="loading"
                  class="w-full"
                  :ui="{ base: 'font-mono text-xs', item: 'gap-2', itemLabel: 'font-mono text-xs' }"
                />
              </UFormField>

              <CapabilityCard
                :label="t('tools.title')"
                icon="i-lucide-wrench"
                :items="enabledToolLabels"
                :total="tools.length"
                :empty-text="t('tools.empty')"
                :manage-label="t('common.manage')"
                :disabled="loading"
                @manage="toolsModalOpen = true"
              />

              <CapabilityCard
                :label="t('skills.title')"
                icon="i-lucide-sparkles"
                :items="enabledSkillLabels"
                :total="skills.length"
                mono
                :empty-text="t('skills.empty')"
                :manage-label="t('common.manage')"
                :disabled="loading"
                @manage="skillsModalOpen = true"
              />

              <CapabilityCard
                v-if="profile"
                :label="t('mcp.title')"
                icon="i-lucide-plug"
                :items="mcpServerLabels"
                mono
                :empty-text="t('mcp.empty')"
                :manage-label="t('common.manage')"
                :disabled="loading"
                @manage="mcpModalOpen = true"
              />

              <UFormField
                :label="t('profileConfig.allowlist')"
                :help="t('profileConfig.allowlistHint')"
              >
                <div class="space-y-2">
                  <div
                    v-if="!allowlist.length"
                    class="allowlist-empty"
                  >
                    {{ t('profileConfig.allowlistEmpty') }}
                  </div>
                  <div
                    v-else
                    class="flex flex-wrap gap-1.5"
                  >
                    <UBadge
                      v-for="entry in allowlist"
                      :key="entry"
                      color="warning"
                      variant="subtle"
                      size="sm"
                      class="allowlist-chip"
                    >
                      <span class="font-mono">{{ entry }}</span>
                      <button
                        type="button"
                        class="allowlist-chip-x"
                        :aria-label="t('profileConfig.allowlistRemove', { entry })"
                        @click="removeAllowlistEntry(entry)"
                      >
                        <UIcon
                          name="i-lucide-x"
                          class="size-3"
                        />
                      </button>
                    </UBadge>
                  </div>
                  <div
                    v-if="allowlist.length"
                    class="flex justify-end"
                  >
                    <UButton
                      size="xs"
                      variant="ghost"
                      color="neutral"
                      icon="i-lucide-trash-2"
                      @click="clearAllowlist"
                    >
                      {{ t('profileConfig.allowlistClear') }}
                    </UButton>
                  </div>
                </div>
              </UFormField>
            </section>
          </div>
        </div>

        <!-- Footer with stamp. -->
        <footer
          v-if="!confirmFire"
          class="dossier-foot"
        >
          <div class="dossier-foot-side">
            <button
              v-if="profile && !profile.isDefault"
              type="button"
              class="fire-link"
              :disabled="loading || submitting || firing"
              @click="confirmFire = true"
            >
              <UIcon
                name="i-lucide-user-minus"
                class="size-3.5"
              />
              <span>{{ t('fire.action') }}</span>
            </button>
            <div
              v-else-if="profile?.isDefault"
              class="fire-link fire-link--blocked"
              :title="t('fire.blockedDefault')"
            >
              <UIcon
                name="i-lucide-shield"
                class="size-3.5"
              />
              <span>{{ t('fire.blockedDefault') }}</span>
            </div>
          </div>
          <div class="dossier-foot-meta">
            <span class="dossier-foot-glyph">▣</span>
            <span class="dossier-foot-label">CALLSIGN</span>
            <span class="dossier-foot-value">{{ displayName.toUpperCase() }}</span>
          </div>
          <div class="dossier-foot-actions">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="submitting"
              @click="emit('update:open', false)"
            >
              {{ t('common.cancel') }}
            </UButton>
            <button
              type="button"
              class="deploy-stamp deploy-stamp--ink"
              :disabled="loading || submitting"
              @click="submit"
            >
              <span class="deploy-stamp-cross">
                <UIcon
                  v-if="submitting"
                  name="i-lucide-loader"
                  class="size-3.5 deploy-stamp-spin"
                />
                <UIcon
                  v-else
                  name="i-lucide-graduation-cap"
                  class="size-3.5"
                />
              </span>
              <span class="deploy-stamp-text">
                {{ submitting ? t('retrain.submitting') : t('retrain.submit') }}
              </span>
            </button>
          </div>
        </footer>

        <!-- Fire confirmation footer — replaces the regular footer in-place. -->
        <footer
          v-else
          class="dossier-foot dossier-foot--danger"
        >
          <div class="fire-confirm-text">
            <strong class="fire-confirm-title">
              {{ t('fire.confirmTitle', { name: displayName }) }}
            </strong>
            <span class="fire-confirm-body">{{ t('fire.confirmBody') }}</span>
          </div>
          <div class="dossier-foot-actions">
            <UButton
              variant="ghost"
              color="neutral"
              :disabled="firing"
              @click="confirmFire = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <button
              type="button"
              class="deploy-stamp"
              :disabled="firing"
              @click="fire"
            >
              <span class="deploy-stamp-cross">
                <UIcon
                  v-if="firing"
                  name="i-lucide-loader"
                  class="size-3.5 deploy-stamp-spin"
                />
                <UIcon
                  v-else
                  name="i-lucide-user-minus"
                  class="size-3.5"
                />
              </span>
              <span class="deploy-stamp-text">
                {{ firing ? t('fire.submitting') : t('fire.confirmAction') }}
              </span>
            </button>
          </div>
        </footer>
      </div>
    </template>
  </UModal>

  <CapabilityModal
    v-model:open="toolsModalOpen"
    :title="t('tools.title')"
  >
    <ToolsPicker
      v-model="enabledTools"
      :tools="tools"
      :loading="loading"
    />
  </CapabilityModal>

  <CapabilityModal
    v-model:open="skillsModalOpen"
    :title="t('skills.title')"
  >
    <SkillsPicker
      v-model="enabledSkills"
      :skills="skills"
      :loading="loading"
    />
  </CapabilityModal>

  <CapabilityModal
    v-if="profile"
    v-model:open="mcpModalOpen"
    :title="t('mcp.title')"
    :subtitle="t('mcp.hint')"
  >
    <McpPicker
      :profile-slug="profile.slug"
      :servers="mcpServers"
      :loading="loading"
      @removed="onMcpRemoved"
    />
  </CapabilityModal>
</template>

<style scoped>
/* === Dossier shell === */
.dossier {
  --paper: #f4efe2;
  --paper-edge: #d8d0b8;
  --ink: #1c1a14;
  --ink-soft: #4a4536;
  --ink-faint: #6b6555;
  --hot: #c8421f;
  --amber: #f3a93b;

  position: relative;
  background: var(--paper);
  color: var(--ink);
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  border-radius: 4px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px var(--paper-edge),
    0 24px 60px -24px rgba(28, 26, 20, 0.55);
  /* Cap modal height + lay out as a flex column so the middle region scrolls
     while head/foot stay pinned. */
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - 4rem);
}
.dossier-head, .dossier-foot { flex-shrink: 0; }
.dossier-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  /* Hide on Firefox/Safari quirks but still allow scrolling. */
  scrollbar-width: thin;
  scrollbar-color: var(--paper-edge) transparent;
}
.dossier-scroll::-webkit-scrollbar { width: 8px; }
.dossier-scroll::-webkit-scrollbar-track { background: transparent; }
.dossier-scroll::-webkit-scrollbar-thumb {
  background: var(--paper-edge);
  border-radius: 4px;
}

/* Neutralize the inner scroll containers in ToolsPicker / SkillsPicker so the
   modal scrolls as a single unit. */
.dossier :deep(.max-h-80),
.dossier :deep(.max-h-96) {
  max-height: none;
}
.dossier::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.045 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  mix-blend-mode: multiply;
  opacity: 0.7;
}

/* === Header sash — Retrain uses amber bar instead of hot to differentiate. === */
.dossier-head {
  position: relative;
  padding: 26px 28px 22px 28px;
  background: var(--ink);
  color: var(--paper);
  border-bottom: 6px solid var(--amber);
}
.dossier-head::before {
  content: '';
  position: absolute;
  inset: 0;
  background:
    repeating-linear-gradient(
      135deg,
      rgba(244, 239, 226, 0.04) 0,
      rgba(244, 239, 226, 0.04) 1px,
      transparent 1px,
      transparent 7px
    );
  pointer-events: none;
}
.dossier-head-stencil {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.34em;
  text-transform: uppercase;
  color: var(--amber);
  margin-bottom: 6px;
  opacity: 0.92;
}
.dossier-title {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 26px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  line-height: 1;
  color: var(--paper);
  margin: 0 0 8px 0;
}
.dossier-subtitle {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 14px;
  color: rgba(244, 239, 226, 0.78);
  margin: 0;
  letter-spacing: 0.01em;
}
.dossier-close {
  position: absolute;
  top: 12px;
  right: 12px;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid rgba(244, 239, 226, 0.22);
  color: var(--paper);
  border-radius: 3px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}
.dossier-close:hover {
  background: rgba(244, 239, 226, 0.08);
  border-color: rgba(244, 239, 226, 0.45);
}
.dossier-cmark {
  position: absolute;
  width: 14px;
  height: 14px;
  border-color: rgba(244, 239, 226, 0.45);
  border-style: solid;
  pointer-events: none;
}
.dossier-cmark--tl { top: 8px; left: 8px; border-width: 1px 0 0 1px; }
.dossier-cmark--tr { top: 8px; right: 50px; border-width: 1px 1px 0 0; }

/* === Section rules === */
.section-rule {
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10px;
  letter-spacing: 0.32em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
.section-rule-line {
  flex: 1;
  height: 1px;
  background-image:
    repeating-linear-gradient(
      to right,
      var(--ink-faint) 0,
      var(--ink-faint) 4px,
      transparent 4px,
      transparent 9px
    );
}

/* === Two-column body === */
.dossier-grid {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0;
  z-index: 1;
}
.dossier-col {
  padding: 18px 24px 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.dossier-col + .dossier-col {
  border-left: 1px dashed rgba(28, 26, 20, 0.22);
}
@media (max-width: 960px) {
  .dossier-grid { grid-template-columns: 1fr; }
  .dossier-col + .dossier-col { border-left: 0; border-top: 1px dashed rgba(28, 26, 20, 0.22); }
}

.field-row {
  display: grid;
  gap: 10px;
}
.field-row--two {
  grid-template-columns: 1fr 1fr;
}
@media (max-width: 640px) {
  .field-row--two { grid-template-columns: 1fr; }
}

.allowlist-empty {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  text-align: center;
  padding: 10px 12px;
  border: 1px dashed rgba(28, 26, 20, 0.25);
  background: rgba(255, 252, 240, 0.45);
  color: var(--ink-faint);
  letter-spacing: 0.02em;
}

.allowlist-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding-right: 2px;
}
.allowlist-chip-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  cursor: pointer;
  background: transparent;
  border: 0;
  color: inherit;
  opacity: 0.6;
  transition: opacity 0.12s ease, background 0.12s ease;
}
.allowlist-chip-x:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.18);
}

/* === Footer with stamp === */
.dossier-foot {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 24px 16px;
  background: rgba(28, 26, 20, 0.04);
  border-top: 1.5px solid var(--ink);
  z-index: 1;
}
.dossier-foot-meta {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--ink-faint);
}
.dossier-foot-glyph { color: var(--amber); font-size: 12px; }
.dossier-foot-value {
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.14em;
}
.dossier-foot-actions { display: inline-flex; align-items: center; gap: 10px; }
.dossier-foot-side { display: inline-flex; align-items: center; }

/* Fire link — quiet on the left, hostile on hover. Reads as "this is a destructive
   exit", not the primary action. */
.fire-link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--ink-faint);
  padding: 5px 9px;
  border-radius: 2px;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}
.fire-link:hover:not(:disabled) {
  color: var(--hot);
  border-color: var(--hot);
  background: rgba(200, 66, 31, 0.06);
}
.fire-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.fire-link--blocked {
  cursor: not-allowed;
  color: var(--ink-faint);
  opacity: 0.7;
}

/* Confirmation footer — full red bar, no ambiguity. */
.dossier-foot--danger {
  background: rgba(200, 66, 31, 0.08);
  border-top: 1.5px solid var(--hot);
}
.fire-confirm-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  margin-right: 16px;
}
.fire-confirm-title {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 12px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--hot);
}
.fire-confirm-body {
  font-family: 'Instrument Serif', serif;
  font-style: italic;
  font-size: 13px;
  line-height: 1.35;
  color: var(--ink-soft);
}

/* Save uses ink-stamp variant (dark) instead of hot stamp, so the two modals read different. */
.deploy-stamp {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 18px 9px;
  background: var(--hot);
  color: var(--paper);
  border: 2px solid var(--hot);
  border-radius: 2px;
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  cursor: pointer;
  box-shadow:
    0 0 0 2px rgba(244, 239, 226, 0.5) inset,
    0 4px 10px -2px rgba(200, 66, 31, 0.45);
  transition: transform 0.1s ease, box-shadow 0.12s ease;
}
.deploy-stamp--ink {
  background: var(--ink);
  border-color: var(--ink);
  box-shadow:
    0 0 0 2px rgba(244, 239, 226, 0.5) inset,
    0 4px 10px -2px rgba(28, 26, 20, 0.45);
}
.deploy-stamp:hover:not(:disabled) {
  transform: translateY(-1px) rotate(-0.6deg);
}
.deploy-stamp:active:not(:disabled) {
  transform: translateY(0) rotate(0deg);
}
.deploy-stamp:disabled {
  background: rgba(28, 26, 20, 0.18);
  border-color: rgba(28, 26, 20, 0.18);
  color: var(--paper);
  cursor: not-allowed;
  box-shadow: none;
}
.deploy-stamp-cross {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  flex-shrink: 0;
}
.deploy-stamp-spin {
  animation: stamp-spin 1s linear infinite;
}
@keyframes stamp-spin {
  to { transform: rotate(360deg); }
}

/* Compact form-field help text + uppercase mono labels — matches HireProfileModal.
   `help` renders below the input (which is what we want for these long hints).
   `hint` (top-right of label) keeps its original size in case anything still uses it. */
.dossier :deep([data-slot="help"]) {
  font-size: 10.5px;
  line-height: 1.35;
  letter-spacing: 0.01em;
  color: var(--ink-faint);
  margin-top: 4px;
}
.dossier :deep([data-slot="description"]) {
  font-size: 10.5px;
  line-height: 1.35;
  color: var(--ink-faint);
}
.dossier :deep(label) {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink-soft);
}
/* Equalize label height across fields in a row so inputs align horizontally. */
.dossier .field-row :deep([data-slot="labelWrapper"]) {
  min-height: 1.25rem;
  display: flex;
  align-items: center;
}
.dossier .field-row {
  align-items: start;
}

/* Model picker rows. Provider tag floats right; "recommended" / "free" badges
   sit between id and provider so they read at a glance. */
.model-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
}
.model-row-id {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.model-row-provider {
  margin-left: auto;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--ink-faint);
  flex-shrink: 0;
}
.model-badge {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 9px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 2px;
  flex-shrink: 0;
}
.model-badge--rec {
  background: rgba(200, 66, 31, 0.12);
  color: var(--hot);
  border: 1px solid rgba(200, 66, 31, 0.3);
}
.model-badge--free {
  background: rgba(243, 169, 59, 0.16);
  color: #8a5a14;
  border: 1px solid rgba(243, 169, 59, 0.4);
}

/* "Inherit from global" toggle. Sits where the provider+model row used to
   be when ON. Mono caps label + italic-serif hint, matches the dossier. */
.inherit-toggle {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  background: rgba(255, 252, 240, 0.55);
  border: 1px dashed rgba(28, 26, 20, 0.2);
  border-radius: 3px;
  cursor: pointer;
}
.inherit-toggle-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.inherit-toggle-label {
  font-family: 'IBM Plex Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink, #1c1a14);
}
.inherit-toggle-hint {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11px;
  color: var(--ink-faint, #6b6555);
  line-height: 1.35;
}

/* Make textareas feel like dossier prose blocks. */
.prose-textarea :deep(textarea) {
  background: rgba(255, 252, 240, 0.7) !important;
  border-color: rgba(28, 26, 20, 0.22) !important;
  font-family: 'IBM Plex Mono', monospace;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink);
}
.prose-textarea :deep(textarea):focus-visible {
  border-color: var(--ink) !important;
  box-shadow: 0 0 0 1px var(--ink) !important;
}
</style>
