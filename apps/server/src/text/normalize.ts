/**
 * Folds Ukrainian and Russian spellings of a place name into one comparable
 * skeleton ("Запоріжжю" → "запорижю", "Вільнянськ" → "вилнянск"). Cross-language
 * pairs that differ in vowels (Оріхів/Орехов) are covered by gazetteer aliases.
 * It's deliberately lossy — only used for matching, never for display.
 */
const CHAR_MAP: Record<string, string> = {
  і: 'и',
  ї: 'и',
  ы: 'и',
  й: 'и',
  є: 'е',
  э: 'е',
  ё: 'е',
  ґ: 'г',
  ъ: '',
  ь: '',
  "'": '',
  '’': '',
  ʼ: '',
  '`': '',
  '"': '',
  '«': '',
  '»': '',
}

const PREFIXES =
  /^(м\.|м |місто |город |г\. ?|смт\.? |с\. ?|село |селище |пос\. ?|н\.п\.? |нп |с-ще |сщ )/

export function foldName(input: string): string {
  let s = input.toLowerCase().normalize('NFC').trim()
  s = s.replace(PREFIXES, '')
  let out = ''
  for (const ch of s) {
    const mapped = CHAR_MAP[ch]
    out += mapped ?? ch
  }
  return (
    out
      .replace(/[-–—_.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      // жж → ж, нн → н (Ukrainian gemination) — but not in abbreviations: "ДД" stays "дд".
      .map((w) => (w.length > 3 ? w.replace(/(.)\1+/g, '$1') : w))
      .join(' ')
  )
}

/** Inflectional endings in folded form (both languages), longest first. */
const ENDINGS = [
  'ского',
  'скому',
  'скою',
  'скои',
  'ами',
  'ями',
  'ови',
  'еви',
  'ого',
  'ому',
  'ою',
  'ею',
  'ах',
  'ях',
  'ам',
  'ям',
  'ом',
  'ем',
  'и',
  'а',
  'я',
  'у',
  'ю',
  'е',
  'о',
] as const

/** Crude stem: folded name without a trailing case ending. Keeps at least 4 chars. */
export function stemName(folded: string): string {
  const words = folded.split(' ')
  return words
    .map((w) => {
      for (const end of ENDINGS) {
        if (w.length - end.length >= 4 && w.endsWith(end)) return w.slice(0, -end.length)
      }
      return w
    })
    .join(' ')
}

/** Jaro–Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1
  if (!a.length || !b.length) return 0
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1)
  const aMatches = new Array<boolean>(a.length).fill(false)
  const bMatches = new Array<boolean>(b.length).fill(false)
  let matches = 0
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - range)
    const hi = Math.min(i + range + 1, b.length)
    for (let j = lo; j < hi; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue
      aMatches[i] = true
      bMatches[j] = true
      matches++
      break
    }
  }
  if (!matches) return 0
  let t = 0
  let k = 0
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue
    while (!bMatches[k]) k++
    if (a[i] !== b[k]) t++
    k++
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3
  let prefix = 0
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++
  return jaro + prefix * 0.1 * (1 - jaro)
}
