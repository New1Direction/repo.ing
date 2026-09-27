import { createReleaseReader } from '../../src/github-release.mjs'
const reader = globalThis.__repoingReleaseReader ??= createReleaseReader()
export const latestRelease = repo => reader.latest(repo)
