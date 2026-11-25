import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  kfClampSpeed,
  kfInit,
  kfPositionSigma,
  kfPredict,
  kfUpdatePosition,
  kfUpdateVelocity,
  kfVelocity,
  velocityFrom,
} from '../src/fusion/kalman'

describe('Kalman filter', () => {
  it('predict moves by velocity and grows uncertainty', () => {
    const s = kfInit({ x: 0, y: 0 }, 2, { x: 1, y: 0 }, 0.5)
    const p = kfPredict(s, 10, 0.5)
    expect(p.x[0]).toBeCloseTo(10)
    expect(p.x[1]).toBeCloseTo(0)
    expect(kfPositionSigma(p)).toBeGreaterThan(kfPositionSigma(s))
  })

  it('predict with dt ≤ 0 is identity (and does not alias)', () => {
    const s = kfInit({ x: 1, y: 2 }, 2, { x: 0, y: 0 }, 1)
    const p = kfPredict(s, -1, 1)
    expect(p).toEqual(s)
    expect(p.P).not.toBe(s.P)
  })

  it('position update pulls the state toward the measurement and shrinks P', () => {
    const s = kfInit({ x: 0, y: 0 }, 10, { x: 0, y: 0 }, 1)
    const { state, d2 } = kfUpdatePosition(s, { x: 10, y: 0 }, 1)
    expect(state.x[0]).toBeGreaterThan(9)
    expect(kfPositionSigma(state)).toBeLessThan(2)
    expect(d2).toBeGreaterThan(0)
  })

  it('learns velocity from a sequence of positions', () => {
    // Object moving 3 km/min east (180 km/h), reported every 2 min with ±2 km noise.
    let s = kfInit({ x: 0, y: 0 }, 3, { x: 0, y: 0 }, 3)
    const noise = [0.8, -1.2, 0.5, 1.5, -0.7, 0.2, -1.1, 0.9]
    noise.forEach((n, i) => {
      s = kfPredict(s, 2, 0.5)
      s = kfUpdatePosition(s, { x: 3 * 2 * (i + 1) + n, y: -n / 2 }, 2).state
    })
    const v = kfVelocity(s)
    expect(v.speedKmh).toBeGreaterThan(150)
    expect(v.speedKmh).toBeLessThan(210)
    expect(Math.abs(v.headingDeg - 90)).toBeLessThan(10)
  })

  it('velocity pseudo-measurement steers the course', () => {
    const s = kfInit({ x: 0, y: 0 }, 2, { x: 0, y: 0 }, 3)
    const { state } = kfUpdateVelocity(s, velocityFrom(315, 180), 1)
    const v = kfVelocity(state)
    expect(v.headingDeg).toBeCloseTo(315, 0)
  })

  it('clamps unrealistic speed', () => {
    const s = kfInit({ x: 0, y: 0 }, 1, { x: 10, y: 0 }, 1)
    expect(kfVelocity(kfClampSpeed(s, 250)).speedKmh).toBeCloseTo(250)
    expect(kfClampSpeed(s, 1000)).toBe(s)
  })

  it('covariance stays symmetric positive-definite under random updates', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dt: fc.double({ min: 0, max: 10, noNaN: true }),
            x: fc.double({ min: -100, max: 100, noNaN: true }),
            y: fc.double({ min: -100, max: 100, noNaN: true }),
            sigma: fc.double({ min: 0.5, max: 30, noNaN: true }),
          }),
          { maxLength: 20 },
        ),
        (steps) => {
          let s = kfInit({ x: 0, y: 0 }, 5, { x: 0, y: 0 }, 3)
          for (const st of steps) {
            s = kfPredict(s, st.dt, 1)
            s = kfUpdatePosition(s, { x: st.x, y: st.y }, st.sigma).state
          }
          for (let r = 0; r < 4; r++) {
            expect(s.P[r * 4 + r]!).toBeGreaterThan(0)
            for (let c = 0; c < 4; c++) expect(s.P[r * 4 + c]).toBeCloseTo(s.P[c * 4 + r]!, 9)
          }
        },
      ),
    )
  })
})
