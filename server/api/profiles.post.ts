import { spawn } from 'node:child_process'
import { useDb, type ProfileRow } from '../utils/db'
import { discoverProfiles } from '../utils/hermes'
import { avatarUrl, defaultSeed, pickColor, type Gesture } from '../utils/avatar'
import { setDisabledSkills } from '../utils/skills'
import { applyToolState, listTools } from '../utils/tools'
import { writeSoul } from '../utils/soul'
import { writeAgents } from '../utils/agents'
import { writeProfileConfig } from '../utils/profile-config'
import { syncRoster } from '../utils/roster'

interface PostBody {
  name?: string
  cloneFrom?: string | null
  disabled?: string[]
  enabledTools?: string[]
  soul?: string
  agents?: string
  preset?: string | null
  model?: string | null
  provider?: string | null
  base_url?: string | null
  /** When true, copy the global model block into the new profile. Sent by
   *  the Hire modal's "Heredar global" toggle when ON. */
  inheritGlobalModel?: boolean
}

const NAME_RE = /^[a-z0-9]+$/

function runHermes(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('hermes', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: string) => stdout += d)
    child.stderr.on('data', (d: string) => stderr += d)
    child.on('error', reject)
    child.on('close', (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

export default defineEventHandler(async (event) => {
  const body = await readBody<PostBody>(event) || {}
  const name = (body.name ?? '').trim()
  const cloneFrom = body.cloneFrom?.trim() || null

  if (!name) throw createError({ statusCode: 400, statusMessage: 'Profile name is required' })
  if (!NAME_RE.test(name)) {
    throw createError({ statusCode: 400, statusMessage: 'Profile name must be lowercase alphanumeric' })
  }

  const db = useDb()

  const existing = db
    .prepare('SELECT slug FROM profiles WHERE slug = ?')
    .get(name) as { slug: string } | undefined
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: `Profile "${name}" already exists` })
  }

  if (cloneFrom) {
    const source = db
      .prepare('SELECT slug FROM profiles WHERE slug = ?')
      .get(cloneFrom) as { slug: string } | undefined
    if (!source) {
      throw createError({ statusCode: 400, statusMessage: `Source profile "${cloneFrom}" not found` })
    }
  }

  const args = ['profile', 'create', name, '--no-alias']
  if (cloneFrom) args.push('--clone-from', cloneFrom)

  const { code, stderr } = await runHermes(args).catch((e: Error) => {
    throw createError({ statusCode: 500, statusMessage: `Failed to invoke hermes: ${e.message}` })
  })

  if (code !== 0) {
    throw createError({
      statusCode: 500,
      statusMessage: stderr.trim() || `hermes profile create exited with code ${code}`
    })
  }

  const discovered = discoverProfiles().find(p => p.slug === name)
  if (!discovered) {
    throw createError({
      statusCode: 500,
      statusMessage: `Profile "${name}" was not found on disk after creation`
    })
  }

  if (Array.isArray(body.disabled) && body.disabled.length > 0) {
    const disabled = body.disabled.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    try {
      setDisabledSkills(discovered.hermesDir, disabled)
    } catch (e) {
      throw createError({
        statusCode: 500,
        statusMessage: `Profile created but failed to apply skills config: ${(e as Error).message}`
      })
    }
  }

  if (typeof body.soul === 'string' && body.soul.trim() !== '') {
    try {
      writeSoul(discovered.hermesDir, body.soul)
    } catch (e) {
      throw createError({
        statusCode: 500,
        statusMessage: `Profile created but failed to write SOUL.md: ${(e as Error).message}`
      })
    }
  }

  if (typeof body.agents === 'string' && body.agents.trim() !== '') {
    try {
      writeAgents(discovered.hermesDir, body.agents)
    } catch (e) {
      throw createError({
        statusCode: 500,
        statusMessage: `Profile created but failed to write AGENTS.md: ${(e as Error).message}`
      })
    }
  }

  const configPatch: {
    model?: string | null
    provider?: string | null
    base_url?: string | null
    inheritGlobalModel?: boolean
  } = {}
  if (body.inheritGlobalModel === true) {
    configPatch.inheritGlobalModel = true
  } else {
    if ('model' in body) configPatch.model = body.model?.trim() || null
    if ('provider' in body) configPatch.provider = body.provider?.trim() || null
    if ('base_url' in body) configPatch.base_url = body.base_url?.trim() || null
  }
  if (Object.keys(configPatch).length > 0) {
    try {
      writeProfileConfig(discovered.hermesDir, configPatch)
    } catch (e) {
      throw createError({
        statusCode: 500,
        statusMessage: `Profile created but failed to write config.yaml: ${(e as Error).message}`
      })
    }
  }

  if (Array.isArray(body.enabledTools)) {
    const requested = new Set(
      body.enabledTools.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    )
    try {
      const current = await listTools(discovered.slug)
      const toEnable: string[] = []
      const toDisable: string[] = []
      for (const t of current) {
        const wantOn = requested.has(t.name)
        if (wantOn && !t.enabled) toEnable.push(t.name)
        else if (!wantOn && t.enabled) toDisable.push(t.name)
      }
      await applyToolState(discovered.slug, toEnable, toDisable)
    } catch (e) {
      throw createError({
        statusCode: 500,
        statusMessage: `Profile created but failed to apply tools config: ${(e as Error).message}`
      })
    }
  }

  const now = new Date().toISOString()
  db.prepare(`
    INSERT INTO profiles (slug, display_name, is_default, hermes_dir, avatar_seed, background_color, gesture, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, 'hand', ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      display_name = excluded.display_name,
      is_default   = excluded.is_default,
      hermes_dir   = excluded.hermes_dir,
      last_seen    = excluded.last_seen
  `).run(
    discovered.slug,
    discovered.slug,
    discovered.isDefault ? 1 : 0,
    discovered.hermesDir,
    defaultSeed(discovered.slug),
    pickColor(discovered.slug),
    now,
    now
  )

  const r = db
    .prepare('SELECT * FROM profiles WHERE slug = ?')
    .get(discovered.slug) as unknown as ProfileRow

  try {
    syncRoster()
  } catch (e) {
    console.error('[roster] sync failed after hire:', (e as Error).message)
  }

  setResponseStatus(event, 201)

  return {
    slug: r.slug,
    displayName: r.display_name,
    givenName: r.given_name,
    isDefault: r.is_default === 1,
    active: r.active === 1,
    hermesDir: r.hermes_dir,
    backgroundColor: r.background_color,
    gesture: r.gesture as Gesture,
    avatarUrl: avatarUrl({
      seed: r.avatar_seed,
      backgroundColor: r.background_color,
      gesture: r.gesture as Gesture,
      size: 240
    }),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen
  }
})
