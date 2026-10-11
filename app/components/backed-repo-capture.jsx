'use client'
import { useEffect } from 'react'
import { captureBackedRepo } from '../lib/backed-repo.mjs'
export function BackedRepoCapture() {
  useEffect(() => { try { captureBackedRepo(window.location.search, window.localStorage) } catch { /* Storage is optional. */ } }, [])
  return null
}
