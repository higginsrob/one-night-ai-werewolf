/** Bridge local-player card taps / tokens (DOM overlay) into the R3F scene. */

import type { WerewolfRole } from './werewolfTypes'

type SelectHandler = () => void
type SelectableListener = (selectable: boolean) => void
type TokenClickHandler = (tokenId: string) => void

export type LocalCardTokenUi = {
  id: string
  role: WerewolfRole
  locked: boolean
  selected: boolean
}

type TokensListener = (tokens: LocalCardTokenUi[]) => void
type TokensInteractiveListener = (interactive: boolean) => void

let selectHandler: SelectHandler | null = null
let selectable = false
const selectableListeners = new Set<SelectableListener>()

let tokenClickHandler: TokenClickHandler | null = null
let localTokens: LocalCardTokenUi[] = []
const tokensListeners = new Set<TokensListener>()
let tokensInteractive = false
const tokensInteractiveListeners = new Set<TokensInteractiveListener>()

export function setLocalCardSelectHandler(handler: SelectHandler | null): void {
  selectHandler = handler
}

export function setLocalCardSelectable(next: boolean): void {
  if (selectable === next) return
  selectable = next
  for (const fn of selectableListeners) fn(selectable)
}

export function getLocalCardSelectable(): boolean {
  return selectable
}

export function subscribeLocalCardSelectable(
  fn: SelectableListener,
): () => void {
  selectableListeners.add(fn)
  fn(selectable)
  return () => {
    selectableListeners.delete(fn)
  }
}

export function requestLocalCardSelect(): void {
  selectHandler?.()
}

export function setLocalTokenClickHandler(
  handler: TokenClickHandler | null,
): void {
  tokenClickHandler = handler
}

export function setLocalTokensInteractive(next: boolean): void {
  if (tokensInteractive === next) return
  tokensInteractive = next
  for (const fn of tokensInteractiveListeners) fn(tokensInteractive)
}

export function getLocalTokensInteractive(): boolean {
  return tokensInteractive
}

export function subscribeLocalTokensInteractive(
  fn: TokensInteractiveListener,
): () => void {
  tokensInteractiveListeners.add(fn)
  fn(tokensInteractive)
  return () => {
    tokensInteractiveListeners.delete(fn)
  }
}

export function setLocalCardTokens(next: LocalCardTokenUi[]): void {
  const same =
    next.length === localTokens.length &&
    next.every((t, i) => {
      const cur = localTokens[i]!
      return (
        t.id === cur.id &&
        t.role === cur.role &&
        t.locked === cur.locked &&
        t.selected === cur.selected
      )
    })
  if (same) return
  localTokens = next
  for (const fn of tokensListeners) fn(localTokens)
}

export function getLocalCardTokens(): LocalCardTokenUi[] {
  return localTokens
}

export function subscribeLocalCardTokens(fn: TokensListener): () => void {
  tokensListeners.add(fn)
  fn(localTokens)
  return () => {
    tokensListeners.delete(fn)
  }
}

export function requestLocalTokenClick(tokenId: string): void {
  tokenClickHandler?.(tokenId)
}
