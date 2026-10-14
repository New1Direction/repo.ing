import { refuseOverLimit } from '../../lib/request-limits.mjs'
import { publicPreflight } from '../../lib/launch-guide.mjs'
import { recordGuide } from '../../lib/launch-guide-events.mjs'
import { guideSource } from '../../lib/launch-guide-funnel.mjs'
import { parseRepositoryInput, publicGuideRepository } from '../../../src/launch-guide.mjs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const headers = { 'Cache-Control': 'no-store' }

// The public launch preflight (docs/LAUNCH_GUIDE.md#preflight): ?repo=<GitHub id, owner/name or URL>. No sign-in, wallet or payment:
// anyone can see what a repository's launch would need and its pre-launch quality facts before committing to anything. Signed-in
// maintainers get the admin check and their plan through /api/launch-guide instead.
export async function GET(request) {
  const params = new URL(request.url).searchParams
  const input = parseRepositoryInput(params.get('repo'))
  if (!input) return Response.json({ error: 'Enter a public GitHub repository: owner/name or its github.com URL.' }, { status: 400, headers })
  const refused = refuseOverLimit(request, 'launch:preflight')
  if (refused) return refused
  try {
    const run = await publicPreflight(input)
    if (!run) return Response.json({ error: 'The preflight is unavailable right now.' }, { status: 503, headers })
    if (run.busy) return Response.json({ error: 'Many preflights are running right now. Try again in a few minutes.' }, { status: 429, headers: { ...headers, 'Retry-After': '300' } })
    const { preflight, profile, repository } = run
    if (!repository && preflight.requirements[0]?.status === 'blocked') {
      return Response.json({ error: 'GitHub does not serve that repository publicly. Only public repositories can launch.' }, { status: 404, headers })
    }
    await recordGuide(request, { event: 'preflight_run', source: guideSource(params.get('src')), repoId: repository?.repoId ?? null,
      outcome: repository ? preflight.verdict : 'unavailable' })
    return Response.json({ preflight, profile, repository: publicGuideRepository(repository) }, { headers })
  } catch (error) {
    console.error('launch preflight failed', { error: error?.message })
    return Response.json({ error: 'The preflight could not finish. Nothing was saved; try again.' }, { status: 503, headers })
  }
}
