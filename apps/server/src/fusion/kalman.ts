/**
 * 2-D constant-velocity Kalman filter.
 * State: [x, y, vx, vy] in km and km/min on a local tangent plane.
 * Covariance is a row-major 4×4 array. Hand-rolled because it's ~60 lines and
 * a matrix library would outweigh the rest of the server.
 */
export interface KalmanState {
  x: [number, number, number, number]
  P: number[]
}

export interface Vec2 {
  x: number
  y: number
}

export function kfInit(pos: Vec2, posSigma: number, vel: Vec2, velSigma: number): KalmanState {
  const p2 = posSigma * posSigma
  const v2 = velSigma * velSigma
  return {
    x: [pos.x, pos.y, vel.x, vel.y],
    P: [p2, 0, 0, 0, 0, p2, 0, 0, 0, 0, v2, 0, 0, 0, 0, v2],
  }
}

const at = (P: number[], r: number, c: number) => P[r * 4 + c]!

/** Propagate by `dt` minutes with white-noise acceleration of intensity `q`. */
export function kfPredict(s: KalmanState, dt: number, q: number): KalmanState {
  if (dt <= 0) return { x: [...s.x], P: [...s.P] }
  const [x, y, vx, vy] = s.x
  const F = [1, 0, dt, 0, 0, 1, 0, dt, 0, 0, 1, 0, 0, 0, 0, 1]
  // P' = F P Fᵀ + Q
  const FP = new Array<number>(16).fill(0)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += F[r * 4 + k]! * at(s.P, k, c)
      FP[r * 4 + c] = sum
    }
  const P = new Array<number>(16).fill(0)
  for (let r = 0; r < 4; r++)
    for (let c = 0; c < 4; c++) {
      let sum = 0
      for (let k = 0; k < 4; k++) sum += FP[r * 4 + k]! * F[c * 4 + k]!
      P[r * 4 + c] = sum
    }
  const q11 = (q * dt ** 3) / 3
  const q12 = (q * dt ** 2) / 2
  const q22 = q * dt
  P[0]! += q11
  P[5]! += q11
  P[2]! += q12
  P[8]! += q12
  P[7]! += q12
  P[13]! += q12
  P[10]! += q22
  P[15]! += q22
  return { x: [x + vx * dt, y + vy * dt, vx, vy], P }
}

/**
 * Update with a 2-D measurement of state components `idx` (position [0,1] or
 * velocity [2,3]). Returns the squared Mahalanobis distance of the innovation
 * so callers can gate outliers.
 */
function update(
  s: KalmanState,
  idx: [number, number],
  z: Vec2,
  sigma: number,
): { state: KalmanState; d2: number } {
  const [i, j] = idx
  const r = sigma * sigma
  const s11 = at(s.P, i, i) + r
  const s12 = at(s.P, i, j)
  const s21 = at(s.P, j, i)
  const s22 = at(s.P, j, j) + r
  const det = s11 * s22 - s12 * s21
  const inv11 = s22 / det
  const inv12 = -s12 / det
  const inv21 = -s21 / det
  const inv22 = s11 / det
  const yx = z.x - s.x[i]!
  const yy = z.y - s.x[j]!
  const d2 = yx * (inv11 * yx + inv12 * yy) + yy * (inv21 * yx + inv22 * yy)

  // K = P Hᵀ S⁻¹ (4×2)
  const K: number[] = []
  for (let row = 0; row < 4; row++) {
    const a = at(s.P, row, i)
    const b = at(s.P, row, j)
    K.push(a * inv11 + b * inv21, a * inv12 + b * inv22)
  }
  const x = s.x.map((v, row) => v + K[row * 2]! * yx + K[row * 2 + 1]! * yy) as KalmanState['x']
  // P = P − K H P
  const P = new Array<number>(16)
  for (let row = 0; row < 4; row++)
    for (let c = 0; c < 4; c++) {
      P[row * 4 + c] =
        at(s.P, row, c) - K[row * 2]! * at(s.P, i, c) - K[row * 2 + 1]! * at(s.P, j, c)
    }
  // Enforce symmetry against floating-point drift.
  for (let row = 0; row < 4; row++)
    for (let c = row + 1; c < 4; c++) {
      const avg = (P[row * 4 + c]! + P[c * 4 + row]!) / 2
      P[row * 4 + c] = avg
      P[c * 4 + row] = avg
    }
  return { state: { x, P }, d2 }
}

export function kfUpdatePosition(s: KalmanState, z: Vec2, sigma: number) {
  return update(s, [0, 1], z, sigma)
}

export function kfUpdateVelocity(s: KalmanState, z: Vec2, sigma: number) {
  return update(s, [2, 3], z, sigma)
}

/**
 * Put the position on a report outright, keeping the velocity. A channel naming a
 * district says where the object is now; blending it with a forecast left the icon
 * kilometres behind for minutes after a turn.
 */
export function kfSnapPosition(s: KalmanState, z: Vec2, sigma: number): KalmanState {
  const P = [...s.P]
  const p2 = sigma * sigma
  for (const i of [0, 1]) {
    for (let c = 0; c < 4; c++) {
      P[i * 4 + c] = 0
      P[c * 4 + i] = 0
    }
    P[i * 4 + i] = p2
  }
  return { x: [z.x, z.y, s.x[2], s.x[3]], P }
}

/** RMS position sigma, km. */
export function kfPositionSigma(s: KalmanState): number {
  return Math.sqrt((at(s.P, 0, 0) + at(s.P, 1, 1)) / 2)
}

/** Velocity as (km/h, bearing°). */
export function kfVelocity(s: KalmanState): { speedKmh: number; headingDeg: number } {
  const vx = s.x[2]
  const vy = s.x[3]
  const heading = (Math.atan2(vx, vy) * 180) / Math.PI
  return { speedKmh: Math.hypot(vx, vy) * 60, headingDeg: (heading + 360) % 360 }
}

/** Scale velocity down so speed ≤ maxKmh. */
export function kfClampSpeed(s: KalmanState, maxKmh: number): KalmanState {
  const speed = Math.hypot(s.x[2], s.x[3]) * 60
  if (speed <= maxKmh || speed === 0) return s
  const k = maxKmh / speed
  return { x: [s.x[0], s.x[1], s.x[2] * k, s.x[3] * k], P: s.P }
}

/** Unit vector (km/min scale) for a bearing and speed. */
export function velocityFrom(headingDeg: number, speedKmh: number): Vec2 {
  const θ = (headingDeg * Math.PI) / 180
  const v = speedKmh / 60
  return { x: v * Math.sin(θ), y: v * Math.cos(θ) }
}
