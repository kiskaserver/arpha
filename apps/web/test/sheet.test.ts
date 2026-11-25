import { describe, expect, it } from 'vitest'
import { clampHeight, PEEK_PX, pickSnap, snapHeights, toggleSnap } from '../src/lib/sheet'

const VH = 800

describe('bottom sheet', () => {
  it('has three stops and clamps drags between them', () => {
    expect(snapHeights(VH)).toEqual({ peek: PEEK_PX, half: 400, full: 704 })
    expect(clampHeight(10, VH)).toBe(PEEK_PX)
    expect(clampHeight(2000, VH)).toBe(704)
    expect(clampHeight(500, VH)).toBe(500)
  })

  it('a slow release snaps to the nearest stop', () => {
    expect(pickSnap(120, 0, VH, 'peek')).toBe('peek')
    expect(pickSnap(350, 0, VH, 'peek')).toBe('half')
    expect(pickSnap(650, 0.1, VH, 'half')).toBe('full')
  })

  it('a fast swipe moves one stop in its direction', () => {
    expect(pickSnap(100, 1.2, VH, 'peek')).toBe('half')
    expect(pickSnap(420, 1.2, VH, 'half')).toBe('full')
    expect(pickSnap(690, 2, VH, 'full')).toBe('full')
    expect(pickSnap(380, -1, VH, 'half')).toBe('peek')
    expect(pickSnap(80, -3, VH, 'peek')).toBe('peek')
  })

  it('tap toggles open/closed', () => {
    expect(toggleSnap('peek')).toBe('half')
    expect(toggleSnap('half')).toBe('peek')
    expect(toggleSnap('full')).toBe('peek')
  })
})
