'use client'
import { useEffect, useRef, useState } from 'react'
import { Check, Image as ImageIcon, LoaderCircle, Upload } from 'lucide-react'

export function TokenImagePicker({ repoId, value, onChange, onBusyChange, disabled }) {
  const [images, setImages] = useState([])
  const [expanded, setExpanded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const input = useRef(null), version = useRef(0), uploadController = useRef(null)
  useEffect(() => {
    const controller = new AbortController(), current = version.current
    setLoading(true)
    fetch(`/api/repo-images/${repoId}`, { signal: controller.signal })
      .then(async response => { if (!response.ok) throw Error(); return response.json() })
      .then(result => {
        setImages(result.images)
        if (result.images.length && current === version.current) onChange(result.images[0])
        if (!result.images.length) setNotice('No suitable repository images found. Upload one below.')
      }).catch(cause => { if (cause.name !== 'AbortError') setNotice('Suggestions are unavailable. You can still upload an image.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [repoId, onChange])
  useEffect(() => { onBusyChange(uploading || (loading && !value)) }, [uploading, loading, value, onBusyChange])
  useEffect(() => () => uploadController.current?.abort(), [])

  async function upload(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setError('')
    if (file.size > 2 * 1024 * 1024) { setError('Choose an image up to 2 MB.'); return }
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) { setError('Choose a PNG, JPEG, WebP, or GIF image.'); return }
    version.current++
    uploadController.current?.abort()
    const controller = new AbortController()
    uploadController.current = controller
    setUploading(true)
    try {
      const response = await fetch(`/api/repo-images/${repoId}`, { method: 'POST', body: file,
        headers: { 'content-type': file.type }, signal: controller.signal })
      const result = await response.json()
      if (!response.ok) throw Error(result.error || 'Could not upload this image.')
      onChange(result); setExpanded(false)
    } catch (cause) { if (cause.name !== 'AbortError') setError(cause.message || 'Upload failed. Please try again.') }
    finally { if (!controller.signal.aborted) setUploading(false) }
  }
  const changing = disabled || uploading
  return <section className="token-image-picker" aria-label="Token image" aria-busy={uploading || loading}>
    <div className="image-picker-current">
      <div className="image-picker-preview">{value ? <img src={value.image} alt="Selected token artwork"/> : <ImageIcon size={32}/>}</div>
      <div className="image-picker-copy"><strong>{uploading ? 'Preparing your image…' : value?.label || (loading ? 'Finding repository images…' : 'Choose a token image')}</strong>
        <span>Fits the full image. Saved with your token at launch.</span>
        <button type="button" className="button outline" disabled={changing} aria-expanded={expanded} aria-controls="token-image-options" onClick={() => setExpanded(!expanded)}>{expanded ? 'Done' : 'Change image'}</button>
      </div>
    </div>
    {(expanded || (!loading && !value)) && <div id="token-image-options" className="image-picker-options">
      {loading ? <p className="image-picker-notice" role="status">Finding suggestions…</p> : images.length > 0 ? <>
        <p className="image-picker-caption">Suggested images</p><div className="image-picker-suggestions" role="group" aria-label="Suggested token images">
          {images.map((item, i) => <button type="button" key={item.source} disabled={changing} aria-pressed={value?.image === item.image}
            aria-label={`Use ${item.label.toLowerCase()} ${i + 1}`} onClick={() => { version.current++; onChange(item); setError('') }}>
            <img src={item.image} alt=""/><span>{item.label}</span>{value?.image === item.image && <Check size={16}/>}</button>)}
        </div>
      </> : <p className="image-picker-notice">{notice}</p>}
      <button type="button" className="button outline" disabled={changing} onClick={() => input.current?.click()}>{uploading ? <LoaderCircle className="image-picker-spinner" size={16}/> : <Upload size={16}/>} {uploading ? 'Preparing image…' : 'Upload image'}</button>
      <span className="image-picker-help">PNG, JPEG, WebP or GIF · Up to 2 MB</span>
    </div>}
    <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden disabled={changing} onChange={upload} aria-label="Upload token image"/>
    <div className="image-picker-feedback" aria-live="polite">{error && <p className="inline-error" role="alert">{error}</p>}</div>
  </section>
}
