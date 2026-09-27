import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/db/schema.mjs',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://postgres:launchtest@127.0.0.1:55432/gitfun_launch' },
})
