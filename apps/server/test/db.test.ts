import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../src/bus'
import { Store } from '../src/db'
import { createLogger } from '../src/logger'

describe('Store', () => {
  it('upserts messages and prunes old ones', () => {
    const s = new Store(':memory:')
    const base = {
      channel: 'c',
      id: 1,
      date: 100,
      editDate: null,
      text: 'a',
      replyToId: null,
      extraction: null,
      trackIds: [],
    }
    s.saveMessage(base)
    s.saveMessage({ ...base, text: 'b', editDate: 200, trackIds: ['t1'], extraction: '{}' })
    expect(s.getMessage('c', 1)).toMatchObject({
      text: 'b',
      editDate: 200,
      trackIds: ['t1'],
      extraction: '{}',
    })
    expect(s.getMessage('c', 2)).toBeNull()
    expect(s.pruneMessages(150)).toBe(1)
    expect(s.getMessage('c', 1)).toBeNull()
  })

  it('persists tracks and subscriptions on disk', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'arpha-db-')), 'nested', 'a.sqlite')
    const s = new Store(path)
    s.saveTrack('t1', { a: 1 }, 1)
    s.saveTrack('t1', { a: 2 }, 2)
    s.saveSubscription('e', { x: 1 })
    s.close()
    const r = new Store(path)
    expect(r.loadTracks()).toEqual([{ a: 2 }])
    expect(r.listSubscriptions()).toEqual([{ x: 1 }])
    r.deleteTrack('t1')
    r.deleteSubscription('e')
    expect(r.loadTracks()).toEqual([])
    expect(r.listSubscriptions()).toEqual([])
    r.close()
  })
})

describe('EventBus', () => {
  it('fans out and unsubscribes', () => {
    const bus = new EventBus()
    const a = vi.fn()
    const off = bus.subscribe(a)
    bus.publish({ type: 'track_removed', id: 'x' })
    off()
    bus.publish({ type: 'track_removed', id: 'y' })
    expect(a).toHaveBeenCalledOnce()
    expect(bus.listenerCount).toBe(0)
  })
})

describe('logger', () => {
  it('creates plain and pretty loggers', () => {
    expect(createLogger('info').level).toBe('info')
    expect(createLogger('debug', true).level).toBe('debug')
  })
})
