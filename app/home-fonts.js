import { Archivo_Black, JetBrains_Mono } from 'next/font/google'

// The home page's type, from repo.ing's video brand (videos/*/frame.md): Archivo Black for headlines, JetBrains Mono for
// labels and numbers. next/font self-hosts both at build time, so the browser never asks Google. Only the headline face is
// preloaded: it sets the largest text on the first screen. Applied as CSS variables on the home page's <main> only.
export const displayFont = Archivo_Black({ weight: '400', subsets: ['latin'], variable: '--font-display', display: 'swap' })
export const monoFont = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap', preload: false })
