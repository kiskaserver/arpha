import type { ThreatType } from './threats'

/** Ukrainian UI labels, shared by the web client and push notifications. */
export const THREAT_LABELS_UK: Record<ThreatType, { one: string; many: string }> = {
  shahed: { one: 'Шахед', many: 'Шахеди' },
  jet_drone: { one: 'Реактивний БпЛА', many: 'Реактивні БпЛА' },
  cruise_missile: { one: 'Крилата ракета', many: 'Крилаті ракети' },
  ballistic: { one: 'Балістика', many: 'Балістика' },
  kab: { one: 'КАБ', many: 'КАБи' },
  recon_drone: { one: 'Розвідувальний БпЛА', many: 'Розвідувальні БпЛА' },
  aircraft: { one: 'Авіація', many: 'Авіація' },
  helicopter: { one: 'Гелікоптер', many: 'Гелікоптери' },
  mlrs: { one: 'РСЗВ', many: 'РСЗВ' },
  unknown: { one: 'Невідома ціль', many: 'Невідомі цілі' },
}

export function threatLabelUk(type: ThreatType, count: number | null): string {
  const label = THREAT_LABELS_UK[type]
  if (count === null || count <= 1) return label.one
  return `${label.many} ×${count}`
}

const COMPASS_UK = ['пн', 'пн-сх', 'сх', 'пд-сх', 'пд', 'пд-зх', 'зх', 'пн-зх'] as const

/** Bearing → short Ukrainian compass label ("пн-зх"). */
export function bearingToCompassUk(deg: number): string {
  const idx = Math.round((((deg % 360) + 360) % 360) / 45) % 8
  return COMPASS_UK[idx]!
}
