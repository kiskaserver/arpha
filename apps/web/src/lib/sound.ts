import type { SoundId } from './settings'

/**
 * Notification sounds synthesised with Web Audio — no files to download, and
 * calm by default (people asked for something that doesn't scare them to death).
 */
let ctx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
  } catch {
    return null
  }
}

function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  gain = 0.15,
  type: OscillatorType = 'sine',
) {
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, start)
  g.gain.setValueAtTime(0, start)
  g.gain.linearRampToValueAtTime(gain, start + 0.02)
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur)
  osc.connect(g).connect(ac.destination)
  osc.start(start)
  osc.stop(start + dur + 0.05)
}

export function playSound(id: SoundId): void {
  if (id === 'off') return
  const ac = audio()
  if (!ac) return
  const t = ac.currentTime + 0.02
  if (id === 'soft') {
    tone(ac, 660, t, 0.35, 0.08)
    tone(ac, 880, t + 0.25, 0.45, 0.07)
  } else if (id === 'chime') {
    tone(ac, 784, t, 0.6, 0.12, 'triangle')
    tone(ac, 1047, t + 0.18, 0.6, 0.1, 'triangle')
    tone(ac, 1319, t + 0.36, 0.9, 0.08, 'triangle')
  } else {
    // Siren: rising/falling sweeps, reserved for ballistic by default.
    for (let i = 0; i < 3; i++) {
      const osc = ac.createOscillator()
      const g = ac.createGain()
      const s = t + i * 0.9
      osc.type = 'sawtooth'
      osc.frequency.setValueAtTime(520, s)
      osc.frequency.linearRampToValueAtTime(980, s + 0.45)
      osc.frequency.linearRampToValueAtTime(520, s + 0.9)
      g.gain.setValueAtTime(0.06, s)
      g.gain.setValueAtTime(0.0001, s + 0.9)
      osc.connect(g).connect(ac.destination)
      osc.start(s)
      osc.stop(s + 0.9)
    }
  }
}

/** Unlock audio on the first user gesture (browsers block autoplay). */
export function unlockAudio(): void {
  audio()
}

export function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* unsupported */
  }
}

export function speak(text: string): void {
  try {
    const synth = globalThis.speechSynthesis
    if (!synth) return
    const u = new SpeechSynthesisUtterance(text)
    u.lang = 'uk-UA'
    const voice = synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('uk'))
    if (voice) u.voice = voice
    u.rate = 1.05
    synth.speak(u)
  } catch {
    /* unsupported */
  }
}
