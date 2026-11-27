import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { haversineKm } from '@arpha/shared'
import { describe, expect, it } from 'vitest'
import { Gazetteer, type PlaceRecord } from '../src/geo/gazetteer'
import {
  mergeRecords,
  parseGeoNames,
  pickUkrainianName,
  transliterateUk,
} from '../src/geo/geonames'
import { foldName, jaroWinkler, stemName } from '../src/text/normalize'

const records = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../../data/gazetteer.json'), 'utf8'),
) as PlaceRecord[]
const gz = new Gazetteer(records)

describe('foldName', () => {
  it('folds Ukrainian specifics, case, apostrophes and prefixes', () => {
    expect(foldName('Запоріжжя')).toBe('запорижя')
    expect(foldName('  м. Кам’янка-Дніпровська ')).toBe('камянка днипровска')
    expect(foldName('смт Кушугум')).toBe('кушугум')
    expect(foldName('с. Ґрунівка')).toBe('грунивка')
    expect(foldName('Энергодар')).toBe(foldName('Енергодар'))
  })

  it('stems case endings but keeps short words', () => {
    expect(stemName(foldName('Василівки'))).toBe(stemName(foldName('Василівка')))
    expect(stemName('рим')).toBe('рим')
  })
})

describe('jaroWinkler', () => {
  it('behaves like the reference implementation', () => {
    expect(jaroWinkler('martha', 'marhta')).toBeCloseTo(0.961, 3)
    expect(jaroWinkler('dixon', 'dicksonx')).toBeCloseTo(0.813, 3)
    expect(jaroWinkler('', 'a')).toBe(0)
    expect(jaroWinkler('abc', 'xyz')).toBe(0)
    expect(jaroWinkler('same', 'same')).toBe(1)
  })
})

describe('Gazetteer (real data)', () => {
  it('has the whole oblast', () => {
    expect(gz.size).toBeGreaterThan(1500)
    expect(records.filter((r) => r.r === 'ZP').length).toBeGreaterThan(1200)
  })

  it.each([
    ['Запоріжжя', 'Запоріжжя'],
    ['Запорожье', 'Запоріжжя'],
    ['Запоріжжю', 'Запоріжжя'],
    ['Оріхів', 'Оріхів'],
    ['Орехов', 'Оріхів'],
    ['Оріхова', 'Оріхів'],
    ['Василівки', 'Василівка'],
    ['Энергодар', 'Енергодар'],
    ['Токмака', 'Токмак'],
    ['Гуляйполе', 'Гуляйполе'],
    ['смт Кушугум', 'Кушугум'],
    ['Бердянск', 'Бердянськ'],
    ['ЗАЕС', 'Запорізька АЕС'],
    ['Хортиця', 'Хортиця'],
    ['Шевченківський район', 'Шевченківський район'],
    ['Мелітополя', 'Мелітополь'],
    // City slang used by local monitoring channels.
    ['Шевчік', 'Шевченківський район'],
    ['Космос', 'Космічний'],
    ['Заводи', 'Заводський район'],
    ['ВХ', 'Верхня Хортиця'],
    ['Осипок', 'Осипенківський'],
    ['Бородок', 'Бородинський'],
    ['Мости', 'Мости Преображенського'],
    ['ГЕС', 'ДніпроГЕС'],
    ['Ліве', 'Запоріжжя-Ліве'],
    ['Кічкас', 'Павло-Кічкас'],
    ['Дослідна', 'Дослідна Станція'],
    ['Соцмісто', 'Соцмісто'],
    ['Бабурки', 'Бабурка'],
    ['Підпорожнянка', 'Підпорожнянка'],
    ['Великий Луг', 'Великий Луг'],
    ['центр', 'Центр міста'],
  ])('%s → %s', (input, expected) => {
    expect(gz.lookup(input)?.name).toBe(expected)
  })

  it('prefers Zaporizhzhia-oblast homonyms and the larger settlement', () => {
    const p = gz.lookup('Гуляйполе')!
    expect(haversineKm(p, { lat: 47.66, lon: 36.26 })).toBeLessThan(10)
    const v = gz.lookup('Василівка')!
    expect(v.kind).toBe('town')
  })

  it('uses proximity to disambiguate villages', () => {
    const near = { lat: 47.3, lon: 36.5 }
    const all = records.filter((r) => r.n === 'Михайлівка' && r.r === 'ZP')
    expect(all.length).toBeGreaterThan(1)
    const picked = gz.lookup('Михайлівка', { near })!
    const closest = Math.min(...all.map((r) => haversineKm(near, r)))
    expect(haversineKm(near, picked)).toBeCloseTo(closest, 3)
  })

  it('a current name beats a historic alias, and proximity picks the homonym', () => {
    // Мелітополь was once called Новоолександрівка; the live village must win.
    const near = { lat: 47.7647, lon: 35.2129 }
    const v = gz.lookup('Новоолександрівка', { near })!
    expect(v.name).toBe('Новоолександрівка')
    expect(haversineKm(v, near)).toBeLessThan(20)
    expect(gz.lookup('Піски', { near })!.name).toBe('Піски')
    expect(haversineKm(gz.lookup('Піски', { near })!, near)).toBeLessThan(10)
  })

  it('tolerates typos via fuzzy matching', () => {
    expect(gz.lookup('Вільнянск')?.name).toBe('Вільнянськ')
    expect(gz.lookup('Степногорськ')?.name).toBe('Степногірськ')
  })

  it('rejects garbage', () => {
    expect(gz.lookup('')).toBeNull()
    expect(gz.lookup('ж')).toBeNull()
    expect(gz.lookup('Токіо')).toBeNull()
  })

  it('reports area precision for raions and the oblast', () => {
    expect(gz.lookup('Пологівський район')!.precisionKm).toBeGreaterThanOrEqual(20)
    expect(gz.lookup('Роботине')!.precisionKm).toBeLessThan(5)
  })
})

describe('GeoNames import', () => {
  const row = (fields: Partial<Record<number, string>>) => {
    const f = Array.from({ length: 19 }, (_, i) => fields[i] ?? '')
    return f.join('\t')
  }
  const tsv = [
    row({
      1: 'Melitopol',
      2: 'Melitopol',
      3: 'Melitopol,Мелитополь,Мелітополь,Киз-Яр',
      4: '46.8489',
      5: '35.3653',
      6: 'P',
      7: 'PPLA2',
      10: '26',
      14: '150000',
    }),
    row({ 1: 'Far', 2: 'Far', 4: '50.4', 5: '30.5', 6: 'P', 7: 'PPL', 10: '04', 14: '5000' }),
    row({ 1: 'Tiny', 2: 'Tiny', 4: '47.9', 5: '35.0', 6: 'P', 7: 'PPL', 10: '04', 14: '10' }),
    row({ 1: 'Lake', 2: 'Lake', 4: '47.9', 5: '35.0', 6: 'H', 7: 'LK', 10: '26' }),
    row({
      1: 'Nikopol',
      2: 'Nikopol',
      3: 'Нікополь',
      4: '47.57',
      5: '34.39',
      6: 'P',
      7: 'PPL',
      10: '04',
      14: '110000',
    }),
    'short\tline',
  ].join('\n')

  it('keeps oblast places and nearby notable neighbours only', () => {
    const recs = parseGeoNames(tsv)
    expect(recs.map((r) => r.n)).toEqual(['Мелітополь', 'Нікополь'])
    expect(recs[0]).toMatchObject({ k: 'city', r: 'ZP', p: 150000 })
    expect(recs[0]!.a).toContain('Мелитополь')
    expect(recs[1]!.r).toBe('DP')
  })

  it('picks the current Ukrainian name, not a historic one', () => {
    expect(pickUkrainianName('Melitopol', ['Киз-Яр', 'Мелитополь', 'Мелітополь'])).toBe(
      'Мелітополь',
    )
    expect(pickUkrainianName('Berdyansk', ['Бердянск', 'Бердянськ', 'Осипенко'])).toBe('Бердянськ')
    expect(pickUkrainianName('Tokmak', [])).toBe('Tokmak')
    expect(transliterateUk('Щасливе')).toBe('shchaslyve')
  })

  it('curated records override generated duplicates', () => {
    const merged = mergeRecords(
      [{ n: 'Запоріжжя', lat: 47.8, lon: 35.1, k: 'city', r: 'ZP' }],
      [
        { n: 'Запоріжжя', lat: 47.81, lon: 35.11, k: 'city', r: 'ZP' },
        { n: 'Запоріжжя', lat: 48.5, lon: 36, k: 'village', r: 'ZP' },
        { n: 'Азов', lat: 3, lon: 3, k: 'town' },
      ],
    )
    expect(merged).toHaveLength(3)
    expect(merged.filter((m) => m.n === 'Запоріжжя').map((m) => m.lat)).toEqual([47.8, 48.5])
  })

  it('"ТОТ Мелітополь" names Мелітополь; look-alike Latin letters are folded', () => {
    expect(gz.lookup('ТОТ Мелітополь')?.name).toBe('Мелітополь')
    expect(gz.lookup('Комишувaха')?.name).toBe('Комишуваха')
    expect(gz.lookup("Кам'янського", { near: { lat: 47.5, lon: 34.6 } })?.name).toMatch(
      /Кам.янське/,
    )
  })
})
