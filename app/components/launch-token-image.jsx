'use client'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'

// The token image the launcher picked on the launch page (a suggestion or an upload), shared between the launch form and the
// large icon at the top of the page, so the top shows the token that will launch, as the token page does after it.
export const LaunchTokenImageContext = createContext({ image: null, setImage() {} })

export function LaunchTokenImageProvider({ children }) {
  const [image, setImage] = useState(null)
  const value = useMemo(() => ({ image, setImage }), [image])
  return <LaunchTokenImageContext.Provider value={value}>{children}</LaunchTokenImageContext.Provider>
}

// The launch form reports its current choice (null while none is ready).
export function useShareLaunchTokenImage(image) {
  const { setImage } = useContext(LaunchTokenImageContext)
  useEffect(() => { setImage(image ?? null) }, [image, setImage])
}

// The top icon: the picked image once there is one, else `children` (the repository's own avatar, rendered by the page).
export function LaunchTokenAvatar({ children }) {
  const { image } = useContext(LaunchTokenImageContext)
  if (!image) return children
  return <div className="repo-avatar large"><img src={image} alt="" width={126} height={126} decoding="async"/></div>
}
