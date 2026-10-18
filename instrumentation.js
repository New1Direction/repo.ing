// Runs once when the Next.js server starts. Hooks install only when explicitly enabled and every
// pinned production input verifies; a refusal is logged and the rest of repo.ing keeps serving.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.HOOK_PRODUCTION_BOOTSTRAP !== 'true') return
  try {
    const { bootstrapProductionHooks } = await import('./src/hooklab-production-bootstrap.mjs')
    await bootstrapProductionHooks()
  } catch (error) {
    console.error('Hook Lab production bootstrap refused:', error?.code === 'PRODUCTION_BOOTSTRAP_REFUSED' ? error.message : 'unexpected error; hooks stay unavailable')
  }
}
