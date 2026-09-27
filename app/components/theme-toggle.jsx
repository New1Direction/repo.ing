'use client'

import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'

export function ThemeToggle() {
  const [theme, setTheme] = useState('dark')

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  }, [])

  function toggle() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'
    document.documentElement.dataset.theme = next
    localStorage.setItem('gitfun-theme', next)
    setTheme(next)
  }

  return <button type="button" className="theme-toggle" onClick={toggle}
    aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
    <Sun className="sun-icon" size={25} strokeWidth={1.6}/>
    <Moon className="moon-icon" size={24} strokeWidth={1.6}/>
  </button>
}
