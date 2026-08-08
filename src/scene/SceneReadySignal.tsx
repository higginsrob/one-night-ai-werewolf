import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'

type SceneReadySignalProps = {
  onReady: () => void
}

export function SceneReadySignal({ onReady }: SceneReadySignalProps) {
  const onReadyRef = useRef(onReady)
  const frames = useRef(0)
  const sent = useRef(false)
  onReadyRef.current = onReady

  useFrame(() => {
    if (sent.current) return
    frames.current += 1
    if (frames.current < 12) return
    sent.current = true
    onReadyRef.current()
  })

  return null
}
