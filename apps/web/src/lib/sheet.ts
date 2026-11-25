/** Bottom-sheet geometry for the mobile threat panel (pure; unit-tested). */
export type Snap = 'peek' | 'half' | 'full'

export const PEEK_PX = 64
const ORDER: Snap[] = ['peek', 'half', 'full']
/** Swipe speed (px/ms) that jumps to the next stop regardless of position. */
const FLING = 0.5

export function snapHeights(viewportPx: number): Record<Snap, number> {
  return {
    peek: PEEK_PX,
    half: Math.round(viewportPx * 0.5),
    full: Math.round(viewportPx * 0.88),
  }
}

export function clampHeight(h: number, viewportPx: number): number {
  const s = snapHeights(viewportPx)
  return Math.min(s.full, Math.max(s.peek, h))
}

/**
 * Where a released drag settles: a fast swipe moves one stop in its direction,
 * otherwise the nearest stop wins. `velocity` is px/ms, positive = upwards.
 */
export function pickSnap(heightPx: number, velocity: number, viewportPx: number, from: Snap): Snap {
  const s = snapHeights(viewportPx)
  const i = ORDER.indexOf(from)
  if (velocity > FLING) return ORDER[Math.min(i + 1, ORDER.length - 1)]!
  if (velocity < -FLING) return ORDER[Math.max(i - 1, 0)]!
  let best: Snap = 'peek'
  for (const snap of ORDER) {
    if (Math.abs(s[snap] - heightPx) < Math.abs(s[best] - heightPx)) best = snap
  }
  return best
}

/** Tap on the handle: open when closed, close when open. */
export const toggleSnap = (s: Snap): Snap => (s === 'peek' ? 'half' : 'peek')
