import type { ThreatClass, ThreatType } from './threats'

/** Ukrainian UI labels, shared by the web client and push notifications. */
export const THREAT_LABELS_UK: Record<ThreatType, { one: string; many: string }> = {
  shahed: { one: 'Шахед', many: 'Шахеди' },
  jet_drone: { one: 'Реактивний БпЛА', many: 'Реактивні БпЛА' },
  molniya: { one: 'Молнія / Ланцет', many: 'Молнії / Ланцети' },
  fpv: { one: 'FPV-дрон', many: 'FPV-дрони' },
  cruise_missile: { one: 'Крилата ракета', many: 'Крилаті ракети' },
  ballistic: { one: 'Балістика', many: 'Балістика' },
  kab: { one: 'КАБ', many: 'КАБи' },
  recon_drone: { one: 'Розвідувальний БпЛА', many: 'Розвідувальні БпЛА' },
  aircraft: { one: 'Авіація', many: 'Авіація' },
  helicopter: { one: 'Гелікоптер', many: 'Гелікоптери' },
  mlrs: { one: 'РСЗВ', many: 'РСЗВ' },
  artillery: { one: 'Артобстріл', many: 'Артобстріл' },
  explosion: { one: 'Вибухи', many: 'Вибухи' },
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

export const THREAT_CLASS_LABELS_UK: Record<ThreatClass, string> = {
  drones: 'Дрони (шахеди, реактивні, FPV, Молнії)',
  missiles: 'Ракети та балістика',
  kab: 'КАБи',
  aviation: 'Авіація',
  ground: 'Артилерія, РСЗВ',
  impact: 'Вибухи / влучання',
}

/** alerts.in.ua `alert_type`. */
export const ALERT_TYPE_LABELS_UK: Record<string, string> = {
  air_raid: 'Повітряна тривога',
  artillery_shelling: 'Загроза артобстрілу',
  urban_fights: 'Загроза вуличних боїв',
  chemical: 'Хімічна загроза',
  nuclear: 'Радіаційна загроза',
}

/** alerts.in.ua `threats[].threat_type`. */
export const OFFICIAL_THREAT_LABELS_UK: Record<string, string> = {
  tactic_aircraft_activity: 'Тактична авіація',
  strategic_aircraft_activity: 'Стратегічна авіація',
  mig31k_departure: 'Зліт МіГ-31К',
  ballistic_missiles: 'Балістика',
  cruise_missiles: 'Крилаті ракети',
  unspecified_missiles: 'Ракетна небезпека',
  drones: 'БпЛА',
  guided_aerial_bombs: 'КАБи',
  air_defense: 'Робота ППО',
  unknown: 'Загроза',
}
