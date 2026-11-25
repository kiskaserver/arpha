/**
 * Threat taxonomy and per-type kinematic defaults.
 *
 * Speeds are typical cruise values used to seed the motion model before we have
 * two observations; `maxSpeedKmh` clamps filter output so noisy reports can't
 * produce physically absurd velocities. The prediction fields drive the
 * reach cone and the impact zone drawn around a threat.
 */
export const THREAT_TYPES = [
  'shahed',
  'jet_drone',
  'molniya',
  'fpv',
  'cruise_missile',
  'ballistic',
  'kab',
  'recon_drone',
  'aircraft',
  'helicopter',
  'mlrs',
  'artillery',
  'explosion',
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
  /** How far ahead the reach cone and likely targets are predicted. */
  predictHorizonMin: number
  /** Half-angle of the reach cone: how sharply the object can plausibly turn. */
  coneHalfAngleDeg: number
  /** Radius of the damage zone around an impact point. */
  impactRadiusKm: number
}

const p = (o: ThreatProfile) => o

export const THREAT_PROFILES: Record<ThreatType, ThreatProfile> = {
  shahed: p({
    speedKmh: 180,
    maxSpeedKmh: 250,
    ttlMin: 25,
    maxExtrapolationMin: 10,
    processNoise: 0.5,
    moving: true,
    predictHorizonMin: 15,
    coneHalfAngleDeg: 30,
    impactRadiusKm: 0.3,
  }),
  jet_drone: p({
    speedKmh: 450,
    maxSpeedKmh: 700,
    ttlMin: 12,
    maxExtrapolationMin: 5,
    processNoise: 2,
    moving: true,
    predictHorizonMin: 5,
    coneHalfAngleDeg: 40,
    impactRadiusKm: 0.3,
  }),
  molniya: p({
    speedKmh: 110,
    maxSpeedKmh: 160,
    ttlMin: 12,
    maxExtrapolationMin: 5,
    processNoise: 1.5,
    moving: true,
    predictHorizonMin: 8,
    coneHalfAngleDeg: 50,
    impactRadiusKm: 0.1,
  }),
  fpv: p({
    speedKmh: 90,
    maxSpeedKmh: 150,
    ttlMin: 8,
    maxExtrapolationMin: 3,
    processNoise: 3,
    moving: true,
    predictHorizonMin: 5,
    coneHalfAngleDeg: 70,
    impactRadiusKm: 0.05,
  }),
  cruise_missile: p({
    speedKmh: 800,
    maxSpeedKmh: 1000,
    ttlMin: 10,
    maxExtrapolationMin: 4,
    processNoise: 4,
    moving: true,
    predictHorizonMin: 4,
    coneHalfAngleDeg: 20,
    impactRadiusKm: 0.5,
  }),
  ballistic: p({
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 4,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
    predictHorizonMin: 2,
    coneHalfAngleDeg: 0,
    impactRadiusKm: 6,
  }),
  kab: p({
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 6,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
    predictHorizonMin: 2,
    coneHalfAngleDeg: 0,
    impactRadiusKm: 3,
  }),
  recon_drone: p({
    speedKmh: 120,
    maxSpeedKmh: 200,
    ttlMin: 30,
    maxExtrapolationMin: 8,
    processNoise: 1,
    moving: true,
    predictHorizonMin: 10,
    coneHalfAngleDeg: 60,
    impactRadiusKm: 0,
  }),
  aircraft: p({
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 20,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
    predictHorizonMin: 0,
    coneHalfAngleDeg: 0,
    impactRadiusKm: 0,
  }),
  helicopter: p({
    speedKmh: 200,
    maxSpeedKmh: 300,
    ttlMin: 15,
    maxExtrapolationMin: 5,
    processNoise: 2,
    moving: true,
    predictHorizonMin: 5,
    coneHalfAngleDeg: 60,
    impactRadiusKm: 0,
  }),
  mlrs: p({
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 3,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
    predictHorizonMin: 0,
    coneHalfAngleDeg: 0,
    impactRadiusKm: 2,
  }),
  artillery: p({
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 10,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
    predictHorizonMin: 0,
    coneHalfAngleDeg: 0,
    impactRadiusKm: 1.5,
  }),
  explosion: p({
    speedKmh: 0,
    maxSpeedKmh: 0,
    ttlMin: 15,
    maxExtrapolationMin: 0,
    processNoise: 0,
    moving: false,
    predictHorizonMin: 0,
    coneHalfAngleDeg: 0,
    impactRadiusKm: 0,
  }),
  unknown: p({
    speedKmh: 150,
    maxSpeedKmh: 400,
    ttlMin: 15,
    maxExtrapolationMin: 6,
    processNoise: 1,
    moving: true,
    predictHorizonMin: 8,
    coneHalfAngleDeg: 45,
    impactRadiusKm: 0.3,
  }),
}

/** Types that may be the same physical object reported with different wording. */
export function typesCompatible(a: ThreatType, b: ThreatType): boolean {
  if (a === b) return true
  if (a === 'explosion' || b === 'explosion') return false
  if (a === 'unknown' || b === 'unknown') return true
  const groups: ThreatType[][] = [
    ['shahed', 'jet_drone', 'recon_drone'],
    ['fpv', 'molniya'],
  ]
  return groups.some((g) => g.includes(a) && g.includes(b))
}

export function isThreatType(value: unknown): value is ThreatType {
  return typeof value === 'string' && (THREAT_TYPES as readonly string[]).includes(value)
}

/** Coarse classes for notification filters and sounds. */
export type ThreatClass = 'drones' | 'missiles' | 'kab' | 'aviation' | 'ground' | 'impact'

export const THREAT_CLASS: Record<ThreatType, ThreatClass> = {
  shahed: 'drones',
  jet_drone: 'drones',
  molniya: 'drones',
  fpv: 'drones',
  recon_drone: 'drones',
  unknown: 'drones',
  cruise_missile: 'missiles',
  ballistic: 'missiles',
  kab: 'kab',
  aircraft: 'aviation',
  helicopter: 'aviation',
  mlrs: 'ground',
  artillery: 'ground',
  explosion: 'impact',
}

export const THREAT_CLASSES: ThreatClass[] = [
  'drones',
  'missiles',
  'kab',
  'aviation',
  'ground',
  'impact',
]
