'use client'

import { useEffect, useRef, useState } from 'react'

// Browsers fetch a <video poster> as soon as the element is parsed, with the page's critical requests, even when the
// video sits far below the fold. Attach the poster only once the video comes within NEAR_VIEWPORT of the screen.
const NEAR_VIEWPORT = '800px 0px'

export function LazyPosterVideo({ poster, children, ...props }) {
  const ref = useRef(null)
  const [nearViewport, setNearViewport] = useState(false)
  useEffect(() => {
    const video = ref.current
    if (!video || typeof IntersectionObserver === 'undefined') { setNearViewport(true); return }
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      setNearViewport(true)
      observer.disconnect()
    }, { rootMargin: NEAR_VIEWPORT })
    observer.observe(video)
    return () => observer.disconnect()
  }, [])
  return <video ref={ref} poster={nearViewport ? poster : undefined} {...props}>{children}</video>
}
