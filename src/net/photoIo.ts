/** Trigger a browser download for a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function dataUrlToBytes(dataUrl: string): Uint8Array | null {
  const match = /^data:image\/[a-zA-Z0-9+.-]+;base64,(.+)$/s.exec(dataUrl.trim())
  if (!match?.[1]) return null
  try {
    const binary = atob(match[1])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    return null
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name.trim().replace(/[^\w-]+/g, '_').slice(0, 40)
  return cleaned || 'player'
}

/** Download a JPEG data URL or fetch a static portrait URL as an image file. */
export async function exportPhotoAsJpeg(
  photoUrl: string,
  nameHint: string,
): Promise<void> {
  const filename = `onw-${sanitizeFilename(nameHint)}.jpg`
  if (photoUrl.startsWith('data:image/')) {
    const bytes = dataUrlToBytes(photoUrl)
    if (!bytes) throw new Error('Could not encode photo.')
    const copy = new Uint8Array(bytes)
    downloadBlob(new Blob([copy], { type: 'image/jpeg' }), filename)
    return
  }
  const res = await fetch(photoUrl)
  if (!res.ok) throw new Error('Could not fetch photo.')
  const blob = await res.blob()
  downloadBlob(blob, filename)
}
