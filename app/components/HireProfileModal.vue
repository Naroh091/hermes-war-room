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

interface ProfilePreset {
  id: string
  iconName: string
  accent: string
  suggestedSlug: string
  soul: string
  agents: string
  tools: string[]
  skills: string[]
}

interface ModelOption {
  id: string
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
interface ModelCatalogResponse {
  updatedAt: string | null
  providers: ProviderOption[]
  models: ModelOption[]
}
interface ModelMenuItem {
  label: string
  value: string
  provider: string
  recommended: boolean
  free: boolean
}

const props = defineProps<{
  open: boolean
  profiles: Profile[]
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  'hired': [profile: Profile]
}>()

const { t, te } = useI18n()
const toast = useToast()

const presets = ref<ProfilePreset[]>([])
const selectedPresetId = ref<string>('custom')

const name = ref('')
const cloneFrom = ref<string | null>(null)
const submitting = ref(false)

const skills = ref<Skill[]>([])
const enabledSkills = ref<string[]>([])
const skillsLoading = ref(false)
const skillsLoaded = ref(false)

const tools = ref<Tool[]>([])
const enabledTools = ref<string[]>([])
const toolsLoading = ref(false)
const toolsLoaded = ref(false)

const soul = ref('')
const soulTouched = ref(false)
const soulLoading = ref(false)

const agents = ref('')
const agentsTouched = ref(false)

const model = ref<string | undefined>(undefined)
const provider = ref<string | undefined>(undefined)
const baseUrl = ref<string | undefined>(undefined)
/* "Inherit from global" — same flag we use in Retrain. Default ON for new
   hires (most common case: don't override the global model/provider). User
   toggles OFF when they want this profile to talk to a different model. */
const inheritGlobal = ref(true)
const modelCatalog = ref<ModelOption[]>([])
const providerCatalog = ref<ProviderOption[]>([])
const catalogLoaded = ref(false)

const toolsModalOpen = ref(false)
const skillsModalOpen = ref(false)

const NAME_RE = /^[a-z0-9]+$/

const cloneOptions = computed(() => [
  { label: t('hire.clonePlaceholder'), value: null },
  ...props.profiles.map(p => ({
    label: p.givenName ? `${p.givenName} (${p.displayName})` : p.displayName,
    value: p.slug
  }))
])

const nameValid = computed(() => NAME_RE.test(name.value.trim()))
const canSubmit = computed(() => nameValid.value && !submitting.value)

const selectedPreset = computed(() =>
  presets.value.find(p => p.id === selectedPresetId.value) ?? null
)

function presetTitle(id: string): string {
  const k = `presets.${id}.title`
  return te(k) ? t(k) : id
}
function presetTagline(id: string): string {
  const k = `presets.${id}.tagline`
  return te(k) ? t(k) : ''
}

async function loadPresets() {
  try {
    const res = await $fetch<{ presets: ProfilePreset[] }>('/api/presets')
    presets.value = res.presets
  } catch (e) {
    console.error('presets load failed', e)
  }
}

async function loadCatalog() {
  if (catalogLoaded.value) return
  try {
    const res = await $fetch<ModelCatalogResponse>('/api/models')
    modelCatalog.value = res.models
    providerCatalog.value = res.providers
  } catch {
    /* catalog optional */
  } finally {
    catalogLoaded.value = true
  }
}

const providerMenuItems = computed(() => {
  const items = providerCatalog.value.map(p => ({ label: p.label, value: p.id, count: p.count }))
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

const enabledToolLabels = computed(() => {
  const lookup = new Map(tools.value.map(tool => [tool.name, tool.label]))
  return enabledTools.value.map(name => lookup.get(name) ?? name)
})
const enabledSkillLabels = computed(() => enabledSkills.value.slice().sort())

const modelMenuItems = computed<ModelMenuItem[]>(() => {
  /* Only narrow the model list when the selected provider actually has models
     in the catalog. Fallback providers (anthropic, openai, custom) have count
     0 — picking them shouldn't hide every model, since `custom` typically
     means "I'll bring my own base_url" and the user still wants to pick any id. */
  const filterProvider = provider.value
  const providerHasModels = !!filterProvider
    && providerCatalog.value.some(p => p.id === filterProvider && p.count > 0)
  const filtered = providerHasModels
    ? modelCatalog.value.filter(m => m.provider === filterProvider)
    : modelCatalog.value

  const items: ModelMenuItem[] = filtered.map(m => ({
    label: m.id,
    value: m.id,
    provider: m.provider,
    recommended: m.recommended,
    free: m.free
  }))

  /* Surface the typed/cloned model id even when it's not in the catalog. */
  const current = model.value
  if (current && !items.some(i => i.value === current)) {
    items.unshift({
      label: current,
      value: current,
      provider: provider.value || '—',
      recommended: false,
      free: false
    })
  }
  return items
})

async function loadSkills() {
  if (skillsLoaded.value || skillsLoading.value) return
  skillsLoading.value = true
  try {
    const list = await $fetch<Skill[]>('/api/skills')
    skills.value = list
    if (selectedPresetId.value === 'custom') {
      enabledSkills.value = list.map(s => s.name)
    }
    skillsLoaded.value = true
    applyPresetSkills()
  } catch (e) {
    toast.add({ title: t('skills.loadFailed'), description: (e as Error).message, color: 'error' })
  } finally {
    skillsLoading.value = false
  }
}

async function loadTools() {
  if (toolsLoaded.value || toolsLoading.value) return
  toolsLoading.value = true
  try {
    const list = await $fetch<Tool[]>('/api/tools')
    tools.value = list
    if (selectedPresetId.value === 'custom') {
      enabledTools.value = list.filter(item => item.enabled).map(item => item.name)
    }
    toolsLoaded.value = true
    applyPresetTools()
  } catch (e) {
    toast.add({ title: t('tools.loadFailed'), description: (e as Error).message, color: 'error' })
  } finally {
    toolsLoading.value = false
  }
}

function applyPresetTools() {
  const p = selectedPreset.value
  if (!p || p.id === 'custom' || !toolsLoaded.value) return
  if (p.tools.length === 0) return
  const known = new Set(tools.value.map(tool => tool.name))
  enabledTools.value = p.tools.filter(n => known.has(n))
}

function applyPresetSkills() {
  const p = selectedPreset.value
  if (!p || p.id === 'custom' || !skillsLoaded.value) return
  if (p.skills.length === 0) return
  const known = new Set(skills.value.map(s => s.name))
  enabledSkills.value = p.skills.filter(n => known.has(n))
}

function applyPreset(id: string) {
  selectedPresetId.value = id
  const p = presets.value.find(pr => pr.id === id)
  if (!p) return

  if (p.id === 'custom') {
    // Custom resets identity but doesn't touch tools/skills (user picked them).
    if (!soulTouched.value) soul.value = ''
    if (!agentsTouched.value) agents.value = ''
    return
  }

  // Suggest slug only if user hasn't typed anything yet.
  if (!name.value.trim()) name.value = p.suggestedSlug

  if (!soulTouched.value) soul.value = p.soul
  if (!agentsTouched.value) agents.value = p.agents

  applyPresetTools()
  applyPresetSkills()
}

watch(() => props.open, (v) => {
  if (v) {
    name.value = ''
    cloneFrom.value = null
    submitting.value = false
    soul.value = ''
    soulTouched.value = false
    agents.value = ''
    agentsTouched.value = false
    model.value = undefined
    provider.value = undefined
    baseUrl.value = undefined
    inheritGlobal.value = true
    selectedPresetId.value = 'custom'
    if (presets.value.length === 0) loadPresets()
    if (!skillsLoaded.value) loadSkills()
    if (!toolsLoaded.value) loadTools()
    loadCatalog()
  }
})

watch(cloneFrom, async (slug) => {
  if (soulTouched.value || selectedPresetId.value !== 'custom') return
  if (!slug) {
    soul.value = ''
    return
  }
  soulLoading.value = true
  try {
    const data = await $fetch<{ soul: string }>(`/api/profiles/${slug}/soul`)
    if (!soulTouched.value) soul.value = data.soul ?? ''
  } catch (e) {
    toast.add({ title: t('soul.loadFailed'), description: (e as Error).message, color: 'error' })
  } finally {
    soulLoading.value = false
  }
})

function onSoulInput(v: string) {
  soul.value = v
  soulTouched.value = true
}
function onAgentsInput(v: string) {
  agents.value = v
  agentsTouched.value = true
}

async function submit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    const enabledSet = new Set(enabledSkills.value)
    const disabled = skillsLoaded.value
      ? skills.value.filter(s => !enabledSet.has(s.name)).map(s => s.name)
      : []

    const soulPayload = soul.value.trim() !== '' ? soul.value : undefined
    const agentsPayload = agents.value.trim() !== '' ? agents.value : undefined

    const created = await $fetch<Profile>('/api/profiles', {
      method: 'POST',
      body: {
        name: name.value.trim(),
        cloneFrom: cloneFrom.value,
        disabled,
        enabledTools: toolsLoaded.value ? enabledTools.value : undefined,
        soul: soulPayload,
        agents: agentsPayload,
        preset: selectedPresetId.value === 'custom' ? null : selectedPresetId.value,
        /* "Heredar global" → server-side: copy the global model block into
           the new profile (default + provider + base_url + api_key). Hermes
           treats each profile config as fully self-contained, so we mirror
           the values rather than rely on inheritance. */
        inheritGlobalModel: inheritGlobal.value,
        model: inheritGlobal.value ? null : (model.value || null),
        provider: inheritGlobal.value ? null : (provider.value || null),
        base_url: inheritGlobal.value ? null : (baseUrl.value?.trim() || null)
      }
    })
    toast.add({
      title: t('hire.success', { name: created.displayName }),
      color: 'primary',
      icon: 'i-lucide-user-plus'
    })
    emit('hired', created)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({
      title: t('hire.failure'),
      description: err.data?.message ?? err.message,
      color: 'error'
    })
  } finally {
    submitting.value = false
  }
}
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
        <!-- Sash header — diagonal stripe with title + subtitle. -->
        <header class="dossier-head">
          <span class="dossier-cmark dossier-cmark--tl" />
          <span class="dossier-cmark dossier-cmark--tr" />
          <div class="dossier-head-stencil">
            Operative File
          </div>
          <h2 class="dossier-title">
            {{ t('hire.title') }}
          </h2>
          <p class="dossier-subtitle">
            {{ t('hire.subtitle') }}
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
          <!-- Preset gallery: cards with icon + title + tagline. -->
          <section class="dossier-presets">
            <div class="section-rule">
              <span class="section-rule-label">{{ t('hire.presetSection') }}</span>
              <span class="section-rule-line" />
            </div>
            <p class="section-hint">
              {{ t('hire.presetHint') }}
            </p>
            <ul
              class="preset-grid"
              role="radiogroup"
              :aria-label="t('hire.presetSection')"
            >
              <li
                v-for="p in presets"
                :key="p.id"
              >
                <button
                  type="button"
                  class="preset-card"
                  :class="{ 'is-active': selectedPresetId === p.id }"
                  :style="{ '--preset-accent': '#' + p.accent }"
                  role="radio"
                  :aria-checked="selectedPresetId === p.id"
                  @click="applyPreset(p.id)"
                >
                  <span class="preset-card-stripe" />
                  <span class="preset-card-icon">
                    <UIcon
                      :name="p.iconName"
                      class="size-4"
                    />
                  </span>
                  <span class="preset-card-text">
                    <span class="preset-card-title">{{ presetTitle(p.id) }}</span>
                    <span class="preset-card-tagline">{{ presetTagline(p.id) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <!-- Two-column intake: briefing on the left, capabilities on the right. -->
          <div class="dossier-grid">
            <section class="dossier-col">
              <div class="section-rule">
                <UIcon
                  name="i-lucide-id-card"
                  class="size-3.5"
                />
                <span class="section-rule-label">{{ t('hire.briefingSection') }}</span>
                <span class="section-rule-line" />
              </div>

              <UFormField
                :label="t('soul.title')"
                :help="t('soul.hint')"
              >
                <UTextarea
                  :model-value="soul"
                  :placeholder="t('soul.placeholder')"
                  :loading="soulLoading"
                  :rows="12"
                  autoresize
                  spellcheck="false"
                  class="w-full prose-textarea"
                  @update:model-value="(v: string | number) => onSoulInput(String(v))"
                />
              </UFormField>

              <UFormField
                :label="t('agents.title')"
                :help="t('agents.hintProfile')"
              >
                <UTextarea
                  :model-value="agents"
                  :placeholder="t('agents.placeholder')"
                  :rows="10"
                  autoresize
                  spellcheck="false"
                  class="w-full prose-textarea"
                  @update:model-value="(v: string | number) => onAgentsInput(String(v))"
                />
              </UFormField>
            </section>

            <section class="dossier-col">
              <div class="section-rule">
                <UIcon
                  name="i-lucide-wrench"
                  class="size-3.5"
                />
                <span class="section-rule-label">{{ t('hire.capabilitiesSection') }}</span>
                <span class="section-rule-line" />
              </div>

              <div class="field-row field-row--two">
                <UFormField
                  :label="t('hire.nameLabel')"
                  :help="t('hire.nameHint')"
                  required
                >
                  <UInput
                    v-model="name"
                    :placeholder="t('hire.namePlaceholder')"
                    autocomplete="off"
                    spellcheck="false"
                    autofocus
                    class="w-full font-mono"
                    @keyup.enter="submit"
                  />
                </UFormField>

                <UFormField
                  :label="t('hire.cloneLabel')"
                  :help="t('hire.cloneHint')"
                >
                  <USelectMenu
                    v-model="cloneFrom"
                    :items="cloneOptions"
                    value-key="value"
                    class="w-full"
                  />
                </UFormField>
              </div>

              <!-- Inherit-from-global toggle. When ON, the profile's
                   config.yaml stays without a model/provider/endpoint override and
                   Hermes resolves both from `~/.hermes/config.yaml` (which
                   keeps `provider: custom` glued to its base_url + api_key).
                   Default ON for new hires; flip OFF to override. -->
              <label class="inherit-toggle">
                <USwitch v-model="inheritGlobal" />
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
                    :create-item="catalogLoaded ? 'always' : false"
                    class="w-full"
                    :ui="{ base: 'font-mono text-xs', item: 'gap-2', itemLabel: 'font-mono text-xs' }"
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
                :disabled="toolsLoading"
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
                :disabled="skillsLoading"
                @manage="skillsModalOpen = true"
              />

              <CapabilityCard
                :label="t('mcp.title')"
                icon="i-lucide-plug"
                :items="[]"
                :empty-text="t('hire.noteAfterCreate')"
                no-manage
              />
            </section>
          </div>
        </div>

        <!-- Footer with deploy stamp. -->
        <footer class="dossier-foot">
          <div class="dossier-foot-meta">
            <span class="dossier-foot-glyph">▣</span>
            <span class="dossier-foot-label">PRESET</span>
            <span class="dossier-foot-value">{{ presetTitle(selectedPresetId).toUpperCase() }}</span>
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
              class="deploy-stamp"
              :disabled="!canSubmit"
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
                  name="i-lucide-check"
                  class="size-3.5"
                />
              </span>
              <span class="deploy-stamp-text">
                {{ submitting ? t('hire.submitting') : t('hire.submit') }}
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
      :loading="toolsLoading"
    />
  </CapabilityModal>

  <CapabilityModal
    v-model:open="skillsModalOpen"
    :title="t('skills.title')"
  >
    <SkillsPicker
      v-model="enabledSkills"
      :skills="skills"
      :loading="skillsLoading"
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
  /* Subtle grain — multiplies cream paper into something that doesn't read flat. */
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.045 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>");
  mix-blend-mode: multiply;
  opacity: 0.7;
}

/* === Header sash === */
.dossier-head {
  position: relative;
  padding: 26px 28px 22px 28px;
  background: var(--ink);
  color: var(--paper);
  border-bottom: 6px solid var(--hot);
}
.dossier-head::before {
  /* Diagonal striping for the "operative file" feel. */
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

/* Corner cmarks — small bracket marks like blueprint registration ticks. */
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

/* === Preset gallery === */
.dossier-presets {
  position: relative;
  padding: 18px 28px 6px;
  z-index: 1;
}
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
.section-hint {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 12px;
  color: var(--ink-faint);
  margin: 6px 0 12px;
  line-height: 1.4;
}

.preset-grid {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
}
.preset-card {
  --preset-accent: #6b6555;
  position: relative;
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 12px 13px 12px 18px;
  background: rgba(255, 253, 245, 0.92);
  border: 1px solid rgba(28, 26, 20, 0.22);
  border-radius: 3px;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.12s ease, background 0.12s ease, transform 0.08s ease;
  font-family: inherit;
  color: inherit;
}
.preset-card:hover {
  border-color: var(--preset-accent);
  background: #fffdf3;
}
.preset-card.is-active {
  border-color: var(--preset-accent);
  background: #fffdf3;
  transform: translateY(-1px);
  box-shadow:
    0 0 0 1px var(--preset-accent) inset,
    0 6px 14px -8px rgba(28, 26, 20, 0.4);
}
.preset-card-stripe {
  position: absolute;
  top: 0;
  left: 0;
  bottom: 0;
  width: 4px;
  background: var(--preset-accent);
  opacity: 0.55;
}
.preset-card.is-active .preset-card-stripe {
  opacity: 1;
}
.preset-card-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 3px;
  background: var(--preset-accent);
  color: var(--paper);
  flex-shrink: 0;
  margin-top: 1px;
}
.preset-card-text {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.preset-card-title {
  font-family: 'Antonio', sans-serif;
  font-weight: 700;
  font-size: 13px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ink);
  line-height: 1;
}
/* Tagline reads as the card's primary message — keep upright sans-serif at a
   comfortable size + dark ink instead of italic ink-soft, which was hard to
   read at 12px. The slightly higher line-height gives breathing room when the
   tagline wraps to two lines. */
.preset-card-tagline {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 12.5px;
  font-weight: 450;
  color: var(--ink);
  line-height: 1.4;
  letter-spacing: 0.005em;
}
.preset-card.is-active .preset-card-title {
  color: var(--preset-accent);
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

.dossier-note {
  font-family: ui-sans-serif, system-ui, sans-serif;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--ink-faint);
  background: rgba(243, 169, 59, 0.1);
  border-left: 3px solid var(--amber);
  padding: 8px 10px;
  margin: 6px 0 0;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

/* Model picker row layout — must mirror the same rules in
   RetrainProfileModal.vue. Provider tag floats right; "recommended" / "free"
   badges sit between id and provider so the eye reads each entry as
   `id  [badge]  PROVIDER`. Without this, the spans collapse together and the
   id text reads as concatenated to the provider (e.g. "qwen3.6custom"). */
.model-row {
  display: flex;
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

/* "Inherit from global" toggle — same shape as the one in Retrain. ON =
   provider+model dropdowns hidden, profile uses the global model:/provider:
   block (with its base_url + api_key). OFF = override per profile. */
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

/* Compact form-field help text + uppercase mono labels. `help` renders below
   the input (Nuxt UI's UFormField slot order: label/hint → description → input
   → help/error), which is the placement we want for long hint sentences. */
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
/* Equalize label height across fields in a row. UFormField's labelWrapper holds
   the label; pinning a min-height keeps the inputs aligned even when one label
   wraps. align-items: start keeps the column heights independent below. */
.dossier .field-row :deep([data-slot="labelWrapper"]) {
  min-height: 1.25rem;
  display: flex;
  align-items: center;
}
.dossier .field-row {
  align-items: start;
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
.dossier-foot-glyph { color: var(--hot); font-size: 12px; }
.dossier-foot-value {
  font-weight: 600;
  color: var(--ink);
  letter-spacing: 0.14em;
}
.dossier-foot-actions { display: inline-flex; align-items: center; gap: 10px; }

/* Stamp-style deploy button: rotated red rectangle, screen-printed feel. */
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
