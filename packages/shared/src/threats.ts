/**
 * Threat taxonomy and per-type kinematic defaults.
 *
 * Speeds are typical cruise values used to seed the motion model before we have
 * two observations; `maxSpeedKmh` clamps filter output so noisy reports can't
 * produce physically absurd velocities.
 */
export const THREAT_TYPES = [
  'shahed',
  'jet_drone',
  'cruise_missile',
  'ballistic',
  'kab',
  'recon_drone',
  'aircraft',
  'helicopter',
  'mlrs',
  'unknown',
] as const

export type ThreatType = (typeof THREAT_TYPES)[number]

export interface ThreatProfile {
  /** Typical speed used when no velocity has been observed yet. */
  speedKmh: number
  /** Hard upper bound for estimated speed. */
  maxSpeedKmh: number
  /** Drop a track after this long without a fresh report. */
  ttlMin: number
  /** Stop dead-reckoning after this long without a fresh report (track then "drifts" in place). */
  maxExtrapolationMin: number
  /** Kalman process noise, km²/min³ — how quickly the object may change velocity. */
  processNoise: number
  /** Whether the object moves on its own path that is worth extrapolating. */
  moving: boolean
}

export const THREAT_PROFILES: Record<ThreatType, ThreatProfile> = {
  shahed: {
    speedKmh: 180,
    maxSpeedKmh: 250,
    ttlMin: 25,
    maxExtrapolationMin: 10,
    processNoise: 0.5,
    moving: true,
  },
  jet_drone: {
    speedKmh: 450,
    maxSpeedKmh: 700,
    ttlMin: 12,
    maxExtrapolationMin: 5,
    processNoise: 2,
    moving: true,
  },
  cruise_missile: {
    speedKmh: 800,
    maxSpeedKmh: 1000,
    ttlMin: 10,
    maxExtrapolationMin: 4,
    processNoise: 4,
    moving: true,
  },
  ballistic: {
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 4,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
  },
  kab: {
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 6,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
  },
  recon_drone: {
    speedKmh: 120,
    maxSpeedKmh: 200,
    ttlMin: 30,
    maxExtrapolationMin: 8,
    processNoise: 1,
    moving: true,
  },
  aircraft: {
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 20,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
  },
  helicopter: {
    speedKmh: 200,
    maxSpeedKmh: 300,
    ttlMin: 15,
    maxExtrapolationMin: 5,
    processNoise: 2,
    moving: true,
  },
  mlrs: {
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 3,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
  },
  unknown: {
    speedKmh: 150,
    maxSpeedKmh: 400,
    ttlMin: 15,
    maxExtrapolationMin: 6,
    processNoise: 1,
    moving: true,
  },
}

/** Types that may be the same physical object reported with different wording. */
export function typesCompatible(a: ThreatType, b: ThreatType): boolean {
  if (a === b) return true
  if (a === 'unknown' || b === 'unknown') return true
  const drones: ThreatType[] = ['shahed', 'jet_drone', 'recon_drone']
  return drones.includes(a) && drones.includes(b)
}

export function isThreatType(value: unknown): value is ThreatType {
  return typeof value === 'string' && (THREAT_TYPES as readonly string[]).includes(value)
}
