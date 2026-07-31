import { useDb, type ProfileRow } from '../../../utils/db'
import { writeProfileConfig, readProfileConfig } from '../../../utils/profile-config'
import { restart as restartAcp } from '../../../utils/orchestrator-acp'

interface PutBody {
  model?: string | null
  provider?: string | null
  base_url?: string | null
  allowlist?: unknown
  name?: string | null
  /** When true, copy the global `model:` block into the profile config so
   *  Hermes sees explicit values. The war-room's "Heredar global" toggle. */
  inheritGlobalModel?: boolean
}

export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, statusMessage: 'Missing slug' })

  const body = await readBody<PutBody>(event) || {}

  const db = useDb()
  const row = db
    .prepare('SELECT * FROM profiles WHERE slug = ?')
    .get(slug) as unknown as ProfileRow | undefined
  if (!row) throw createError({ statusCode: 404, statusMessage: 'Profile not found' })

  const patch: Parameters<typeof writeProfileConfig>[1] = {}
  if (body.inheritGlobalModel === true) {
    patch.inheritGlobalModel = true
  } else {
    if ('model' in body) {
      if (body.model === null || typeof body.model === 'string') patch.model = body.model
    }
    if ('provider' in body) {
      if (body.provider === null || typeof body.provider === 'string') patch.provider = body.provider
    }
    if ('base_url' in body) {
      if (body.base_url === null || typeof body.base_url === 'string') patch.base_url = body.base_url
    }
  }
  if ('allowlist' in body) {
    if (!Array.isArray(body.allowlist)) {
      throw createError({ statusCode: 400, statusMessage: '`allowlist` must be an array of strings' })
    }
    patch.allowlist = body.allowlist.filter((v): v is string => typeof v === 'string')
  }
  if ('name' in body) {
    if (body.name === null || typeof body.name === 'string') patch.name = body.name
  }

  if (Object.keys(patch).length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'No-op' })
  }

  try {
    writeProfileConfig(row.hermes_dir, patch)
  } catch (e) {
    throw createError({ statusCode: 500, statusMessage: `Failed to update config: ${(e as Error).message}` })
  }

  // Force the ACP child for this slug to respawn so the next mission turn
  // picks up the new model / allowlist. Hermes reads config at process start.
  const restarted = restartAcp(slug)

  return {
    ...readProfileConfig(row.hermes_dir),
    acpRestarted: restarted.killed
  }
})
