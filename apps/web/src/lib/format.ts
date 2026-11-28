import { bearingToCompassUk, formatMinutesUk, type Track } from '@arpha/shared'
import { uk } from './i18n'

export function formatSpeed(track: Track): string {
  return track.speedKmh ? `~${Math.round(track.speedKmh / 10) * 10} ${uk.kmh}` : '—'
}

export function formatCourse(track: Track): string {
  return track.headingDeg === null
    ? '—'
    : `${bearingToCompassUk(track.headingDeg)} (${track.headingDeg}°)`
}

/** "Оріхів / Таврійське": the goal and the alternatives the post gave. */
export function targetNames(track: Track): string {
  return [track.target, ...(track.altTargets ?? [])]
    .filter((t) => t !== null)
    .map((t) => t.name)
    .join(' / ')
}

export function formatDistance(km: number): string {
  return km < 10 ? `${km.toFixed(1)} ${uk.km}` : `${Math.round(km)} ${uk.km}`
}

export function formatEta(etaMin: number | null): string {
  if (etaMin === null) return uk.etaNone
  if (etaMin === 0) return uk.etaArrived
  return `~${formatMinutesUk(etaMin)}`
}

export function formatAgo(at: number, now: number): string {
  return uk.ago(Math.max(0, (now - at) / 1000))
}

export function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })
}
