import {
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
} from 'react'
import { Text, useTexture } from '@react-three/drei'
import * as THREE from 'three'
import { DOC_ART, type LobbyDocId } from '../game/onwArt'
import { RoleCardMesh } from '../game/RoleCardMesh'
import {
  ROLE_CARD_DEPTH,
  ROLE_CARD_HEIGHT,
  ROLE_CARD_WIDTH,
} from '../game/roleCardTextures'
import { ROLE_POOL } from '../game/roles'
import { applyCoverMap } from './coverTexture'
import {
  DocumentFocusController,
  type DocFocusHandle,
} from './DocumentFocusController'
import {
  listLobbyCatalog,
  type LobbyCatalogEntry,
} from './lobbyCatalog'
import { TABLE_TOP } from './RoundTable'

type Props = {
  selectedId: string | null
  onSelect: (id: string) => void
  onDismissDoc?: () => void
  onReadingTarget?: (target: [number, number, number] | null) => void
  /** Selected physical cards as ROLE_POOL indices. */
  deck: number[]
  /** Host (or anyone-can-admin) may toggle cards on the board. */
  canEditDeck: boolean
  /** Toggle a physical pool card on/off by its ROLE_POOL index. */
  onToggleRole: (poolIndex: number) => void
  deckNeed: number
}

/** Compensates for smaller ROLE_CARD_* so the lobby deck stays readable. */
const DECK_SCALE = 0.5
const DECK_COLS = 5
/** Extra space between card edges — keep wider than the selection ring. */
const DECK_GAP_X = 0.24
const DECK_GAP_Z = 0.2

/** Document sheet width on the table (height derived from aspect). */
const DOC_BASE_WIDTH = 0.48
const DOC_DEPTH = 0.008

function interactProps(onSelect: () => void) {
  return {
    onClick: (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      onSelect()
    },
    onPointerOver: (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      document.body.style.cursor = 'pointer'
    },
    onPointerOut: () => {
      document.body.style.cursor = 'auto'
    },
  }
}

function DocumentSheet({
  entry,
  focused,
  handlesRef,
  onSelect,
}: {
  entry: LobbyCatalogEntry
  /** Brightens the sheet while lifted for reading. */
  focused: boolean
  handlesRef: MutableRefObject<Map<LobbyDocId, DocFocusHandle>>
  onSelect: () => void
}) {
  const docId = entry.id as LobbyDocId
  const art = DOC_ART[docId]
  const map = useTexture(art.url)
  const groupRef = useRef<THREE.Group>(null)

  const width = DOC_BASE_WIDTH
  const height = width / art.aspect

  useLayoutEffect(() => {
    map.colorSpace = THREE.SRGBColorSpace
    map.anisotropy = 4
    const img = map.image as { width?: number; height?: number } | undefined
    if (img?.width && img?.height) {
      applyCoverMap(map, img.width, img.height, art.aspect)
    }
    map.needsUpdate = true
  }, [map, art.aspect])

  const [x, , z] = entry.position
  const y = TABLE_TOP + DOC_DEPTH * 0.5 + 0.012
  // Stack offset so sheets don't z-fight.
  const stackLift =
    docId === 'rules' ? 0.004 : docId === 'roles' ? 0.008 : 0
  const tablePos = useMemo(
    () => new THREE.Vector3(x, y + stackLift, z),
    [x, y, z, stackLift],
  )
  const tableQuat = useMemo(() => {
    const e = new THREE.Euler(-Math.PI / 2, 0, entry.rotationY ?? 0)
    return new THREE.Quaternion().setFromEuler(e)
  }, [entry.rotationY])

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return
    const map = handlesRef.current
    const handle: DocFocusHandle = {
      id: docId,
      group,
      table: {
        position: tablePos.clone(),
        quaternion: tableQuat.clone(),
        scale: 1,
      },
      baseHeight: height,
    }
    map.set(docId, handle)
    // Seed table pose immediately
    group.position.copy(handle.table.position)
    group.quaternion.copy(handle.table.quaternion)
    group.scale.setScalar(1)
    return () => {
      map.delete(docId)
    }
  }, [docId, handlesRef, height, tablePos, tableQuat])

  // Keep table pose in sync when layout changes (controller reads handle.table).
  useLayoutEffect(() => {
    const handle = handlesRef.current.get(docId)
    if (!handle) return
    handle.table.position.copy(tablePos)
    handle.table.quaternion.copy(tableQuat)
    handle.baseHeight = height
  }, [docId, handlesRef, height, tablePos, tableQuat])

  return (
    <group ref={groupRef} {...interactProps(onSelect)}>
      <mesh castShadow receiveShadow>
        <boxGeometry args={[width, height, DOC_DEPTH]} />
        <meshStandardMaterial
          color="#1a1410"
          roughness={0.9}
          metalness={0.04}
        />
      </mesh>
      <mesh position={[0, 0, DOC_DEPTH * 0.52 + 0.0005]}>
        <planeGeometry args={[width * 0.985, height * 0.985]} />
        <meshStandardMaterial
          map={map}
          roughness={0.72}
          metalness={0.02}
          emissive="#0c0a08"
          emissiveIntensity={0.08}
        />
      </mesh>
      {/* Stable read light — keeps contrast independent of camera distance. */}
      {focused && (
        <pointLight
          position={[0, 0, 0.65]}
          intensity={4.2}
          distance={3.2}
          decay={2}
          color="#fff6e8"
        />
      )}
    </group>
  )
}

function LobbyDeckCards({
  deck,
  canEditDeck,
  onToggleRole,
  deckNeed,
}: {
  deck: number[]
  canEditDeck: boolean
  onToggleRole: (poolIndex: number) => void
  deckNeed: number
}) {
  const selectedSet = useMemo(() => new Set(deck), [deck])

  const cards = useMemo(() => {
    const gapX = ROLE_CARD_WIDTH * DECK_SCALE + DECK_GAP_X
    const gapZ = ROLE_CARD_HEIGHT * DECK_SCALE + DECK_GAP_Z
    const rows = Math.ceil(ROLE_POOL.length / DECK_COLS)
    const originX = -((DECK_COLS - 1) * gapX) / 2
    const originZ = ((rows - 1) * gapZ) / 2 - 0.05
    const y = TABLE_TOP + ROLE_CARD_DEPTH * DECK_SCALE * 0.5 + 0.01

    return ROLE_POOL.map((role, poolIndex) => {
      const col = poolIndex % DECK_COLS
      const row = Math.floor(poolIndex / DECK_COLS)
      const yaw = ((poolIndex * 17) % 7) * 0.008 - 0.024
      return {
        key: `pool-${poolIndex}`,
        role,
        poolIndex,
        selected: selectedSet.has(poolIndex),
        yaw,
        position: [
          originX + col * gapX,
          y,
          originZ - row * gapZ,
        ] as [number, number, number],
      }
    })
  }, [selectedSet])

  const rows = Math.ceil(ROLE_POOL.length / DECK_COLS)
  const labelZ =
    ROLE_CARD_HEIGHT * DECK_SCALE * 0.5 +
    ((rows - 1) * (ROLE_CARD_HEIGHT * DECK_SCALE + DECK_GAP_Z)) / 2 +
    0.28

  return (
    <group>
      <Text
        position={[0, TABLE_TOP + 0.02, labelZ]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.075}
        color="#e8d5a3"
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.008}
        outlineColor="#0a120c"
      >
        {`Characters  ${deck.length}/${deckNeed}`}
      </Text>
      {canEditDeck && (
        <Text
          position={[0, TABLE_TOP + 0.02, labelZ + 0.14]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.048}
          color="#a8b0a0"
          anchorX="center"
          anchorY="middle"
        >
          Tap a card to add or remove
        </Text>
      )}
      {cards.map(({ key, role, poolIndex, selected, yaw, position }) => (
        <RoleCardMesh
          key={key}
          role={role}
          faceDown={false}
          selected={selected}
          dimmed={!selected}
          selectable={canEditDeck}
          position={position}
          rotation={[-Math.PI / 2, 0, yaw]}
          scale={DECK_SCALE}
          onClick={
            canEditDeck ? () => onToggleRole(poolIndex) : undefined
          }
        />
      ))}
    </group>
  )
}

export function LobbyGameProps({
  selectedId,
  onSelect,
  onDismissDoc,
  onReadingTarget,
  deck,
  canEditDeck,
  onToggleRole,
  deckNeed,
}: Props) {
  const catalog = listLobbyCatalog()
  const handlesRef = useRef<Map<LobbyDocId, DocFocusHandle>>(new Map())
  const focusedDoc =
    selectedId === 'getting-started' ||
    selectedId === 'rules' ||
    selectedId === 'roles'
      ? selectedId
      : null

  return (
    <group>
      <DocumentFocusController
        focusedId={focusedDoc}
        handlesRef={handlesRef}
        onDismiss={onDismissDoc ?? (() => {})}
        onReadingTarget={onReadingTarget}
      />
      {catalog.map((entry) => (
        <DocumentSheet
          key={entry.id}
          entry={entry}
          focused={selectedId === entry.id}
          handlesRef={handlesRef}
          onSelect={() => onSelect(entry.id)}
        />
      ))}
      <LobbyDeckCards
        deck={deck}
        canEditDeck={canEditDeck}
        onToggleRole={onToggleRole}
        deckNeed={deckNeed}
      />
    </group>
  )
}
