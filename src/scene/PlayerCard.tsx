import { useEffect, useMemo, useRef, useState } from 'react'
import { Billboard, RoundedBox, Text } from '@react-three/drei'
import { useFrame, type ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { REACTION_TTL_MS } from '../config'
import { faceEmojiForPlayer, facePhotoForPlayer } from '../emoticons'
import {
  getBrowserTtsSpeakerId,
  subscribeBrowserTtsSpeaker,
} from '../game/browserTts'
import type { PlayerPublic, ReactionEvent } from '../session/types'
import {
  clearPlayerCardFocus,
  publishPlayerCardFocus,
  setOrbitFocusPlayerId,
} from './playerCardFocus'
import { getPlayerCardBodyTexture } from './playerCardTextures'
import { useFilteredFaceTexture } from './useFilteredFaceTexture'

const CARD_W = 0.86
const CARD_H = 1.32
const CARD_DEPTH = 0.014
const CARD_RADIUS = 0.06
const BORDER = 0.028
const FACE_W = CARD_W - BORDER * 2
const FACE_H = CARD_H - BORDER * 2
const FACE_RADIUS = Math.max(0.03, CARD_RADIUS - 0.018)
const BUBBLE_Y = CARD_H / 2 + 0.22
/** Winner / Loser label floats just above the card top edge. */
const OUTCOME_LABEL_Y = CARD_H / 2 + 0.18
const WIN_GOLD = '#c9a227'
const WIN_GOLD_GLOW = '#f0c040'
const SPEAK_YELLOW = '#f5d44a'
const SPEAK_YELLOW_GLOW = '#ffe566'

function makeRoundedPlaneGeometry(
  width: number,
  height: number,
  radius: number,
  curveSegments = 8,
): THREE.ShapeGeometry {
  const w = width / 2
  const h = height / 2
  const r = Math.min(radius, w, h)
  const shape = new THREE.Shape()
  shape.moveTo(-w + r, -h)
  shape.lineTo(w - r, -h)
  shape.quadraticCurveTo(w, -h, w, -h + r)
  shape.lineTo(w, h - r)
  shape.quadraticCurveTo(w, h, w - r, h)
  shape.lineTo(-w + r, h)
  shape.quadraticCurveTo(-w, h, -w, h - r)
  shape.lineTo(-w, -h + r)
  shape.quadraticCurveTo(-w, -h, -w + r, -h)
  const geom = new THREE.ShapeGeometry(shape, curveSegments)
  const uv = geom.attributes.uv
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) + w) / width, (uv.getY(i) + h) / height)
  }
  uv.needsUpdate = true
  return geom
}

const BODY_GEOM = makeRoundedPlaneGeometry(CARD_W, CARD_H, CARD_RADIUS)
const FACE_GEOM = makeRoundedPlaneGeometry(FACE_W, FACE_H, FACE_RADIUS)

type Props = {
  player: PlayerPublic
  position: [number, number, number]
  highlight?: boolean
  /** Celebrate this player as the current round/match winner. */
  winner?: boolean
  /** Other versus seat while a winner is celebrating. */
  loser?: boolean
  label?: string
  /** Line under the card (e.g. who they voted for at reveal). */
  footer?: string
  /** Red ✕ tally: how many votes this player currently has against them. */
  votesAgainst?: number
  /** This player is the live room host. */
  isRoomHost?: boolean
  /** Host can tap the card to cycle lobby seats. */
  selectable?: boolean
  onSelect?: () => void
  /** Active reaction events from this player. */
  reactions?: ReactionEvent[]
}

function stop(e: ThreeEvent<MouseEvent>) {
  e.stopPropagation()
}

function FloatingReaction({
  reaction,
  offsetX,
}: {
  reaction: ReactionEvent
  offsetX: number
}) {
  const groupRef = useRef<THREE.Group>(null)
  const [alive, setAlive] = useState(true)

  useFrame(() => {
    const age = Date.now() - reaction.at
    const t = age / REACTION_TTL_MS
    if (t >= 1) {
      if (alive) setAlive(false)
      return
    }
    if (!groupRef.current) return
    groupRef.current.position.y = BUBBLE_Y + 0.28 + t * 0.55
    groupRef.current.position.x = offsetX + Math.sin(t * Math.PI * 2) * 0.04
    const s = 0.85 + (1 - t) * 0.35
    groupRef.current.scale.setScalar(s)
  })

  if (!alive) return null

  return (
    <group ref={groupRef} position={[offsetX, BUBBLE_Y + 0.28, 0.05]}>
      <Text fontSize={0.28} anchorX="center" anchorY="middle">
        {reaction.emoji}
      </Text>
    </group>
  )
}

export function PlayerCard({
  player,
  position,
  highlight = false,
  winner = false,
  loser = false,
  label,
  footer,
  votesAgainst = 0,
  isRoomHost = false,
  selectable = false,
  onSelect,
  reactions = [],
}: Props) {
  const moodOpts = { winner, loser, reactions }
  const facePhoto = facePhotoForPlayer(player, moodOpts)
  const faceEmoji = faceEmojiForPlayer(player, moodOpts)
  const faceTexture = useFilteredFaceTexture({
    photoDataUrl: facePhoto,
    mediaFilter: player.mediaFilter,
  })
  const showFace = Boolean(faceTexture)

  const [ttsSpeakerId, setTtsSpeakerId] = useState(() =>
    getBrowserTtsSpeakerId(),
  )
  useEffect(() => subscribeBrowserTtsSpeaker(setTtsSpeakerId), [])
  const speaking = ttsSpeakerId === player.id

  const rootRef = useRef<THREE.Group>(null)
  const frameRef = useRef<THREE.Group>(null)
  const winRingRef = useRef<THREE.Mesh>(null)
  const speakRingRef = useRef<THREE.Mesh>(null)
  const worldPos = useRef(new THREE.Vector3())

  useEffect(() => () => clearPlayerCardFocus(player.id), [player.id])

  useFrame(({ clock }) => {
    if (rootRef.current) {
      rootRef.current.getWorldPosition(worldPos.current)
      publishPlayerCardFocus(
        player.id,
        worldPos.current.x,
        worldPos.current.y,
        worldPos.current.z,
      )
    }
    if (!frameRef.current) return
    const t = clock.elapsedTime
    if (winner) {
      const pulse = 1.08 + Math.sin(t * 4.2) * 0.04
      frameRef.current.scale.setScalar(pulse)
      if (winRingRef.current) {
        const mat = winRingRef.current.material as THREE.MeshBasicMaterial
        mat.opacity = 0.55 + Math.sin(t * 4.2) * 0.2
      }
    } else if (speaking) {
      const pulse = 1.1 + Math.sin(t * 5.5) * 0.06
      frameRef.current.scale.setScalar(pulse)
      if (speakRingRef.current) {
        const mat = speakRingRef.current.material as THREE.MeshBasicMaterial
        mat.opacity = 0.65 + Math.sin(t * 5.5) * 0.25
      }
    } else if (highlight) {
      const s = 1 + Math.sin(t * 3) * 0.012
      frameRef.current.scale.setScalar(s)
    } else {
      frameRef.current.scale.setScalar(1)
    }
  })

  const activeReactions = reactions.slice(-4)
  const displayLabel = winner ? 'Winner' : loser ? 'Loser' : label
  const bodyMap = useMemo(
    () => getPlayerCardBodyTexture(player.color),
    [player.color],
  )
  // Keep the face plane clearly in front of the body (low-precision mobile depth).
  const zFace = CARD_DEPTH / 2 + 0.001
  const zFacePhoto = zFace + 0.008
  const zOverlay = zFacePhoto + 0.004

  return (
    <group ref={rootRef} position={position}>
      <Billboard follow>
        <group
          ref={frameRef}
          onClick={(e) => {
            stop(e)
            setOrbitFocusPlayerId(player.id)
            if (selectable) onSelect?.()
          }}
          onPointerDown={stop}
          onPointerOver={() => {
            document.body.style.cursor = 'pointer'
          }}
          onPointerOut={() => {
            document.body.style.cursor = 'auto'
          }}
        >
          {winner && (
            <RoundedBox
              ref={winRingRef}
              args={[CARD_W + 0.06, CARD_H + 0.06, CARD_DEPTH]}
              radius={CARD_RADIUS + 0.015}
              smoothness={6}
              position={[0, 0, -0.004]}
            >
              <meshBasicMaterial color={WIN_GOLD} transparent opacity={0.7} />
            </RoundedBox>
          )}

          {speaking && !winner && (
            <RoundedBox
              ref={speakRingRef}
              args={[CARD_W + 0.08, CARD_H + 0.08, CARD_DEPTH]}
              radius={CARD_RADIUS + 0.02}
              smoothness={6}
              position={[0, 0, -0.005]}
            >
              <meshBasicMaterial
                color={SPEAK_YELLOW}
                transparent
                opacity={0.75}
              />
            </RoundedBox>
          )}

          {/* Outer card shape — rounded to match the face planes. */}
          <RoundedBox
            args={[CARD_W, CARD_H, CARD_DEPTH]}
            radius={CARD_RADIUS}
            smoothness={6}
            castShadow
          >
            <meshStandardMaterial
              color={player.color}
              emissive={
                winner
                  ? WIN_GOLD_GLOW
                  : speaking
                    ? SPEAK_YELLOW_GLOW
                    : player.color
              }
              emissiveIntensity={
                winner ? 0.22 : speaking ? 0.28 : highlight ? 0.1 : 0.04
              }
              roughness={0.75}
              metalness={winner || speaking ? 0.18 : 0.05}
            />
          </RoundedBox>

          <mesh position={[0, 0, zFace]} geometry={BODY_GEOM}>
            <meshBasicMaterial map={bodyMap} toneMapped={false} />
          </mesh>

          <mesh position={[0, 0, zFacePhoto]} geometry={FACE_GEOM}>
            {showFace && faceTexture ? (
              <meshBasicMaterial
                key={faceTexture.uuid}
                map={faceTexture}
                color="#ffffff"
                toneMapped={false}
              />
            ) : (
              <meshBasicMaterial
                color="#050508"
                transparent
                opacity={0.72}
                depthWrite={false}
              />
            )}
          </mesh>

          {!showFace && (
            <Text
              position={[0, 0.04, zOverlay]}
              fontSize={0.28}
              color={player.color}
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.01}
              outlineColor="#0a0c12"
            >
              {player.name.slice(0, 1).toUpperCase()}
            </Text>
          )}

          {faceEmoji && !winner && !loser && (
            <Text
              position={[FACE_W / 2 - 0.1, FACE_H / 2 - 0.1, zOverlay]}
              fontSize={0.14}
              anchorX="center"
              anchorY="middle"
            >
              {faceEmoji}
            </Text>
          )}

          <Text
            position={[0, -CARD_H / 2 + 0.12, zOverlay]}
            fontSize={0.085}
            color="#f0ebe3"
            anchorX="center"
            anchorY="middle"
            maxWidth={CARD_W - 0.16}
            outlineWidth={0.014}
            outlineColor="#0a0c12"
          >
            {player.name}
          </Text>

          {isRoomHost && (
            <Text
              position={[0, -CARD_H / 2 + 0.22, zOverlay]}
              fontSize={0.06}
              color={WIN_GOLD}
              anchorX="center"
              outlineWidth={0.01}
              outlineColor="#0a0c12"
            >
              Host
            </Text>
          )}

          {(winner || loser) && (
            <Text
              position={[0, OUTCOME_LABEL_Y, zOverlay]}
              fontSize={0.24}
              color={winner ? WIN_GOLD_GLOW : '#d8dce6'}
              anchorX="center"
              anchorY="bottom"
              outlineWidth={0.028}
              outlineColor="#0a0c12"
              letterSpacing={0.02}
            >
              {displayLabel}
            </Text>
          )}

          {displayLabel && !winner && !loser && (
            <Text
              position={[0, CARD_H / 2 - 0.1, zOverlay]}
              fontSize={0.065}
              color="#c9a227"
              anchorX="center"
              outlineWidth={0.012}
              outlineColor="#0a0c12"
            >
              {displayLabel}
            </Text>
          )}

          {votesAgainst > 0 && (
            <Text
              position={[0, -CARD_H / 2 - 0.08, zOverlay]}
              fontSize={0.12}
              color="#ff8a7a"
              anchorX="center"
              anchorY="top"
              outlineWidth={0.014}
              outlineColor="#0a0c12"
            >
              {'✕'.repeat(votesAgainst)}
            </Text>
          )}

          {footer && (
            <Text
              position={[
                0,
                -CARD_H / 2 - (votesAgainst > 0 ? 0.22 : 0.08),
                zOverlay,
              ]}
              fontSize={0.095}
              color="#e8e2d8"
              anchorX="center"
              anchorY="top"
              maxWidth={CARD_W + 0.28}
              outlineWidth={0.014}
              outlineColor="#0a0c12"
            >
              {footer}
            </Text>
          )}

          {activeReactions.map((r, i) => {
            const n = activeReactions.length
            const offsetX = n === 1 ? 0 : (i - (n - 1) / 2) * 0.22
            return (
              <FloatingReaction key={r.id} reaction={r} offsetX={offsetX} />
            )
          })}
        </group>
      </Billboard>
    </group>
  )
}
