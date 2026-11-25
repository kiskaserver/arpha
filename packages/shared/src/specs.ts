import type { ThreatType } from './threats'

/**
 * Publicly documented characteristics of Russian strike weapons used against
 * Zaporizhzhia. They seed the motion model (speed, max speed), bound the
 * forecast (range) and are shown on the threat card. Figures are typical
 * operational values from open sources; each entry links them.
 */
export interface WeaponSpec {
  id: string
  type: ThreatType
  nameUk: string
  /** Spellings used by channels (UA/RU), for the extractor prompt. */
  aliases: string[]
  cruiseKmh: number
  maxKmh: number
  /** Operational range, km. */
  rangeKm: number
  /** Warhead mass, kg (typical; ranges given as text). */
  warheadKg: string
  note: string
  sources: string[]
}

const WIKI = 'https://en.wikipedia.org/wiki/'

export const WEAPON_SPECS: WeaponSpec[] = [
  {
    id: 'shahed_136',
    type: 'shahed',
    nameUk: 'Шахед-136 / Герань-2',
    aliases: ['шахед', 'герань-2', 'герань', 'мопед', 'Shahed-136'],
    cruiseKmh: 180,
    maxKmh: 220,
    rangeKm: 2000,
    warheadKg: '40–90',
    note: 'Поршневий двигун, характерний звук «мопеда». Летить на 50–2000 м.',
    sources: [
      `${WIKI}HESA_Shahed_136`,
      'https://www.globalsecurity.org/military/world/iran/shahed-136.htm',
    ],
  },
  {
    id: 'geran_3',
    type: 'jet_drone',
    nameUk: 'Герань-3 (реактивний шахед)',
    aliases: ['реактив', 'реактивний', 'герань-3', 'Geran-3'],
    cruiseKmh: 370,
    maxKmh: 600,
    rangeKm: 1000,
    warheadKg: '50–90',
    note: 'Турбореактивний. Конструктивно до 600 км/год, у реальному застосуванні ~370 км/год.',
    sources: ['https://www.pravda.com.ua/eng/articles/2026/05/19/8035370/'],
  },
  {
    id: 'gerbera',
    type: 'shahed',
    nameUk: 'Гербера (дрон-імітатор)',
    aliases: ['гербера', 'імітатор', 'хибна ціль'],
    cruiseKmh: 160,
    maxKmh: 200,
    rangeKm: 600,
    warheadKg: '0–10',
    note: 'Дешева приманка для ППО, частіше без бойової частини.',
    sources: [`${WIKI}Gerbera_(drone)`],
  },
  {
    id: 'molniya_2',
    type: 'molniya',
    nameUk: 'Молнія-2',
    aliases: ['молнія', 'молния'],
    cruiseKmh: 120,
    maxKmh: 140,
    rangeKm: 60,
    warheadKg: '3–6',
    note: 'Простий дрон літакового типу (алюміній і пластик), запускається з лінії фронту.',
    sources: [
      'https://www1.ru/en/news/2025/05/02/raskryty-oficialnye-xarakteristiki-drona-molniia-2-sostoit-iz-aliuminievyx-trub-i-plastika.html',
    ],
  },
  {
    id: 'lancet_3',
    type: 'molniya',
    nameUk: 'Ланцет-3',
    aliases: ['ланцет', 'lancet'],
    cruiseKmh: 110,
    maxKmh: 300,
    rangeKm: 40,
    warheadKg: '3–5',
    note: 'Барражуючий боєприпас, у піке до 300 км/год. Дальність 30–65 км.',
    sources: [`${WIKI}ZALA_Lancet`, 'https://greydynamics.com/lancet-3-russias-spear-in-the-sky/'],
  },
  {
    id: 'fpv',
    type: 'fpv',
    nameUk: 'FPV-дрон (радіо)',
    aliases: ['фпв', 'fpv', 'фпвшка'],
    cruiseKmh: 120,
    maxKmh: 180,
    rangeKm: 15,
    warheadKg: '1–3',
    note: 'Керується по радіо, дальність зазвичай до 10–20 км.',
    sources: ['https://www.radiosvoboda.org/a/zaporizhzhya-fpv-kaby-drony-reportazh/33846517.html'],
  },
  {
    id: 'fpv_fiber',
    type: 'fpv',
    nameUk: 'FPV-дрон на оптоволокні',
    aliases: ['оптоволокно', 'на оптиці', 'оптика'],
    cruiseKmh: 80,
    maxKmh: 100,
    rangeKm: 25,
    warheadKg: '1–3',
    note: 'Не глушиться РЕБ. Летить повільніше (60–100 км/год), дальність до 20–40 км.',
    sources: [`${WIKI}Fiber_optic_drone`],
  },
  {
    id: 'orlan_10',
    type: 'recon_drone',
    nameUk: 'Орлан-10',
    aliases: ['орлан', 'орлан-10'],
    cruiseKmh: 110,
    maxKmh: 150,
    rangeKm: 110,
    warheadKg: '—',
    note: 'Розвідник-коригувальник: за ним часто йде артилерія або КАБи.',
    sources: [`${WIKI}STC_Orlan-10`],
  },
  {
    id: 'zala',
    type: 'recon_drone',
    nameUk: 'ZALA / Суперкам',
    aliases: ['зала', 'zala', 'суперкам', 'supercam'],
    cruiseKmh: 90,
    maxKmh: 120,
    rangeKm: 70,
    warheadKg: '—',
    note: 'Легкий розвідувальний БпЛА.',
    sources: [`${WIKI}ZALA_421-06`],
  },
  {
    id: 'umpk_fab500',
    type: 'kab',
    nameUk: 'ФАБ-500 з УМПК',
    aliases: ['каб', 'каби', 'фаб-500', 'умпк'],
    cruiseKmh: 800,
    maxKmh: 1000,
    rangeKm: 70,
    warheadKg: '~200 ВР (500 кг бомба)',
    note: 'Планує 40–70 км від точки скиду, 4–6 хв у повітрі.',
    sources: [`${WIKI}UMPK_(bomb_kit)`],
  },
  {
    id: 'umpk_fab1500',
    type: 'kab',
    nameUk: 'ФАБ-1500 з УМПК',
    aliases: ['фаб-1500', 'півторатонна'],
    cruiseKmh: 750,
    maxKmh: 950,
    rangeKm: 60,
    warheadKg: '~675 ВР (1500 кг бомба)',
    note: 'Найважча планувальна бомба, дальність ~60 км.',
    sources: [
      'https://en.defence-ua.com/news/15_ton_fab_1500_became_a_guided_glide_bomb_with_umpk_kit_russian_sources_claim-7851.html',
    ],
  },
  {
    id: 'umpk_jet',
    type: 'kab',
    nameUk: 'КАБ з реактивним прискорювачем (УМПК-Д)',
    aliases: ['реактивний каб', 'умпк-д'],
    cruiseKmh: 800,
    maxKmh: 1000,
    rangeKm: 150,
    warheadKg: '~200',
    note: 'З прискорювачем до 100–200 км.',
    sources: ['https://theaviationist.com/2025/10/25/russia-new-jet-powered-glide-bomb/'],
  },
  {
    id: 'iskander_m',
    type: 'ballistic',
    nameUk: 'Іскандер-М (9М723)',
    aliases: ['іскандер', 'искандер', 'балістика'],
    cruiseKmh: 5400,
    maxKmh: 7400,
    rangeKm: 500,
    warheadKg: '480–700',
    note: 'До 6–7 Мах. Від Криму до Запоріжжя — близько 3 хвилин.',
    sources: [`${WIKI}9K720_Iskander`, 'https://war-sanctions.gur.gov.ua/en/ballistics/iskander'],
  },
  {
    id: 'kn_23',
    type: 'ballistic',
    nameUk: 'KN-23 (КНДР)',
    aliases: ['kn-23', 'кн-23'],
    cruiseKmh: 5400,
    maxKmh: 8000,
    rangeKm: 690,
    warheadKg: '~500',
    note: 'Північнокорейська балістика, до ~6,9 Мах.',
    sources: ['https://www.kyivpost.com/analysis/27502'],
  },
  {
    id: 's300_ground',
    type: 'ballistic',
    nameUk: 'С-300 / С-400 по наземних цілях',
    aliases: ['с-300', 'с-400', 'с300'],
    cruiseKmh: 4300,
    maxKmh: 7000,
    rangeKm: 150,
    warheadKg: '~150',
    note: 'Зенітні ракети по місту: дуже швидкі, тривога часто запізнюється.',
    sources: [`${WIKI}S-300_missile_system`],
  },
  {
    id: 'kinzhal',
    type: 'ballistic',
    nameUk: 'Кинджал (Х-47М2)',
    aliases: ['кинджал', 'кинжал'],
    cruiseKmh: 7000,
    maxKmh: 12000,
    rangeKm: 2000,
    warheadKg: '480',
    note: 'Аеробалістична, запуск з МіГ-31К.',
    sources: [`${WIKI}Kh-47M2_Kinzhal`],
  },
  {
    id: 'kh_101',
    type: 'cruise_missile',
    nameUk: 'Х-101',
    aliases: ['х-101', 'x-101', 'х101'],
    cruiseKmh: 720,
    maxKmh: 970,
    rangeKm: 3500,
    warheadKg: '400–450',
    note: 'Пуск з Ту-95/Ту-160, летить низько з обходом ППО.',
    sources: [`${WIKI}Kh-101`],
  },
  {
    id: 'kalibr',
    type: 'cruise_missile',
    nameUk: 'Калібр',
    aliases: ['калібр', 'калибр'],
    cruiseKmh: 900,
    maxKmh: 980,
    rangeKm: 2000,
    warheadKg: '450',
    note: 'Морського базування (Чорне/Каспійське море).',
    sources: [`${WIKI}Kalibr_(missile_family)`],
  },
  {
    id: 'kh_59',
    type: 'cruise_missile',
    nameUk: 'Х-59 / Х-69',
    aliases: ['х-59', 'х-69', 'x-59'],
    cruiseKmh: 900,
    maxKmh: 1080,
    rangeKm: 290,
    warheadKg: '310–320',
    note: 'Авіаційна, пуск з Су-34/Су-35 над окупованим півднем.',
    sources: [`${WIKI}Kh-59`, `${WIKI}Kh-69`],
  },
  {
    id: 'kh_22',
    type: 'cruise_missile',
    nameUk: 'Х-22 / Х-32',
    aliases: ['х-22', 'х-32'],
    cruiseKmh: 3500,
    maxKmh: 4600,
    rangeKm: 600,
    warheadKg: '500–1000',
    note: 'Надзвукова, падає майже вертикально.',
    sources: [`${WIKI}Kh-22`, `${WIKI}Kh-32`],
  },
]

export const WEAPON_IDS = WEAPON_SPECS.map((s) => s.id)

const BY_ID = new Map(WEAPON_SPECS.map((s) => [s.id, s]))

/** The default (most common) model for each type. */
export const DEFAULT_MODEL: Partial<Record<ThreatType, string>> = {
  shahed: 'shahed_136',
  jet_drone: 'geran_3',
  molniya: 'molniya_2',
  fpv: 'fpv',
  recon_drone: 'orlan_10',
  kab: 'umpk_fab500',
  ballistic: 'iskander_m',
  cruise_missile: 'kh_59',
}

export function weaponSpec(model: string | null | undefined, type?: ThreatType): WeaponSpec | null {
  if (model && BY_ID.has(model)) return BY_ID.get(model)!
  const fallback = type ? DEFAULT_MODEL[type] : undefined
  return fallback ? (BY_ID.get(fallback) ?? null) : null
}

/** Minutes for a ballistic/cruise missile to cover `km` (average ≈ 75 % of max speed). */
export function flightMinutes(spec: WeaponSpec, km: number): number {
  return km / ((spec.maxKmh * 0.75) / 60)
}
