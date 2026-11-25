import { afterEach, describe, expect, it, vi } from 'vitest'

class FakeParam {
  setValueAtTime = vi.fn()
  linearRampToValueAtTime = vi.fn()
  exponentialRampToValueAtTime = vi.fn()
}
class FakeNode {
  type = ''
  frequency = new FakeParam()
  gain = new FakeParam()
  connect = vi.fn(() => this)
  start = vi.fn()
  stop = vi.fn()
}
class FakeAudioContext {
  static created = 0
  static oscillators = 0
  state = 'suspended'
  currentTime = 0
  destination = {}
  resume = vi.fn(async () => {})
  constructor() {
    FakeAudioContext.created++
  }
  createOscillator() {
    FakeAudioContext.oscillators++
    return new FakeNode()
  }
  createGain() {
    return new FakeNode()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function load() {
  return import('../src/lib/sound')
}

describe('sound', () => {
  it('synthesises each profile without audio files; off is silent', async () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    const { playSound, unlockAudio } = await load()
    unlockAudio()
    expect(FakeAudioContext.created).toBe(1)
    const before = FakeAudioContext.oscillators
    playSound('off')
    expect(FakeAudioContext.oscillators).toBe(before)
    playSound('soft')
    playSound('chime')
    playSound('siren')
    expect(FakeAudioContext.oscillators - before).toBe(2 + 3 + 3)
    expect(FakeAudioContext.created).toBe(1) // one shared context
  })

  it('degrades silently without Web Audio', async () => {
    vi.stubGlobal('AudioContext', () => {
      throw new Error('unsupported')
    })
    const { playSound } = await load()
    expect(() => playSound('chime')).not.toThrow()
  })

  it('vibrates and speaks Ukrainian when available', async () => {
    const vibrate = vi.fn()
    vi.stubGlobal('navigator', { vibrate })
    const speak = vi.fn()
    vi.stubGlobal('speechSynthesis', {
      speak,
      getVoices: () => [{ lang: 'en-US' }, { lang: 'uk-UA', name: 'Lesya' }],
    })
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        lang = ''
        voice: unknown = null
        rate = 1
        constructor(public text: string) {}
      },
    )
    const mod = await load()
    mod.vibrate([100, 50])
    expect(vibrate).toHaveBeenCalledWith([100, 50])
    mod.speak('Увага')
    const u = speak.mock.calls[0]![0]
    expect(u).toMatchObject({ text: 'Увага', lang: 'uk-UA', voice: { name: 'Lesya' } })
  })

  it('no-ops when vibration or speech are missing', async () => {
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('speechSynthesis', undefined)
    const mod = await load()
    expect(() => mod.vibrate([1])).not.toThrow()
    expect(() => mod.speak('x')).not.toThrow()
  })
})
