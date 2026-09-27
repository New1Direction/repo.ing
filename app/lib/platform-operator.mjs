// A normal builder session grants repository rights, never treasury rights.
export function requirePlatformOperator(session, env = process.env) {
  if (!session || session.scope !== 'builders' || !Number.isFinite(session.expiresAt) || session.expiresAt <= Date.now()) {
    throw Object.assign(Error('Sign in with your operator GitHub account.'), { status: 401 })
  }
  const ids = (env.PLATFORM_OPERATOR_GITHUB_IDS ?? '').split(',').map(s=>s.trim()).filter(Boolean)
  if (!ids.length || ids.some(id=>! /^[1-9]\d*$/.test(id)) || !ids.includes(session.githubUserId)) {
    throw Object.assign(Error('This action requires a configured platform operator.'), { status: 403 })
  }
  return session
}
