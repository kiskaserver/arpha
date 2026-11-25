import { bearingToCompassUk, THREAT_TYPES, WEAPON_IDS, WEAPON_SPECS } from '@arpha/shared'
import { ACTIONS, type ExtractionInput, HEADINGS, PRECISIONS } from './types'

export const TOOL_NAME = 'report_threats'

/** JSON schema the model must fill via forced tool use. */
export const REPORT_TOOL = {
  name: TOOL_NAME,
  description:
    'Report every aerial/strike threat described in the Telegram message, or mark it irrelevant.',
  input_schema: {
    type: 'object' as const,
    additionalProperties: false,
    required: ['relevant', 'all_clear', 'events'],
    properties: {
      relevant: {
        type: 'boolean',
        description:
          'True if the message reports a current threat, its movement, its destruction, or an all-clear.',
      },
      closures: {
        type: 'array',
        description:
          'Bridges/dam/roads reported closed or reopened ("мости та ГЕС перекрито", "рух мостами відновлено").',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['object', 'status'],
          properties: {
            object: {
              type: 'string',
              description:
                'Canonical name: "Мости Преображенського", "ДніпроГЕС", "Арковий міст", …',
            },
            status: { type: 'string', enum: ['closed', 'open'] },
          },
        },
      },
      all_clear: {
        type: 'boolean',
        description:
          'True only for an all-clear ("відбій", "чисто") for Zaporizhzhia city or oblast as a whole.',
      },
      events: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'action', 'confidence'],
          properties: {
            type: { type: 'string', enum: [...THREAT_TYPES] },
            model: {
              type: ['string', 'null'],
              enum: [...WEAPON_IDS, null],
              description: 'Specific weapon model only when the post names or clearly implies it.',
            },
            count: {
              type: ['integer', 'null'],
              description: 'Number of objects; upper bound for ranges.',
            },
            action: { type: 'string', enum: [...ACTIONS] },
            location: {
              type: ['string', 'null'],
              description:
                'Where the object is NOW. Ukrainian, nominative case, settlement or district name only.',
            },
            precision: { type: ['string', 'null'], enum: [...PRECISIONS, null] },
            from: {
              type: ['string', 'null'],
              description: 'Where it came from (Ukrainian, nominative).',
            },
            toward: {
              type: ['string', 'null'],
              description: 'Where it is heading (Ukrainian, nominative).',
            },
            heading: { type: ['string', 'null'], enum: [...HEADINGS, null] },
            track_id: {
              type: ['string', 'null'],
              description: 'Id from ACTIVE TRACKS if this is the same object/group, else null.',
            },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
}

const WEAPON_LINES = WEAPON_SPECS.map((w) => `- ${w.id}: ${w.aliases.join(', ')}`).join(
  String.fromCharCode(10),
)

export const SYSTEM_PROMPT = `You convert Ukrainian/Russian Telegram air-raid monitoring posts about Zaporizhzhia city and oblast into structured threat events.

HOW THESE CHANNELS WRITE
- Local monitors post a running commentary as a CHAIN OF SHORT REPLIES: "Реактивний від Вільнянська на Запоріжжя" → reply "Ліве" → reply "До центру" → reply "До Бабурки". Each short reply ("Кушугум", "Космос", "На мости", "Півколо") is a position/heading UPDATE of the object from the reply chain: same type, action=update, reuse its track id.
- A bare place name = where the object is now (location). "В районі X" / "біля X" = location X (not from), even when a course follows. "На X", "До X", "курс X", "курсом на X", "у бік X" = toward. "Повз X" = location X. "Від X"/"з боку X" = from. "X курс Y" = location X, toward Y.
- "Зробив коло", "кружляє", "півколо над містом" = still active (update, no location unless named). "Знову" in a reply = the same object again.
- Posts are informal, abbreviated, use emoji, mix Ukrainian and Russian.

THREAT TYPES (pick the most specific):
- shahed: шахед, шахєд, герань/герани, мопед, газонокосарка, "ударні БпЛА", "БпЛА типу Shahed", дрон-камікадзе, "бпла" when attack drones are implied.
- jet_drone: реактив, реактивний, "реактивний шахед/БпЛА", Герань-3.
- molniya: Молнія/Молния, Ланцет, "дрон літакового типу" with a short range (front line → city outskirts).
- fpv: FPV, ФПВ, "фпвшка", "дрон-камікадзе" over the city outskirts (Космос, Балабине, Кушугум…). Track them: location + course.
- cruise_missile: крилата ракета, КР, Калібр, Х-101, Х-555, Х-59, Х-69, "ракета курсом на…".
- ballistic: балістика, Іскандер, КН-23, С-300/С-400 по наземних цілях, "загроза балістики", "швидкісна ціль".
- kab: КАБ, КАБи, каби, керовані авіабомби, УМПК, "пуски КАБ", "скид КАБ" (a KAB release; "скид каб у бік Запоріжжя" → kab toward Запоріжжя).
- aircraft: кабовоз (a KAB-carrying jet), тактична авіація, Су-34/35/25, "активність авіації", борт.
- recon_drone: розвідник, розвідувальний БпЛА, Орлан, Зала, Суперкам, Мавік.
- helicopter: гелікоптер, вертоліт, Ка-52, Мі-8.
- mlrs: РСЗВ, Град, Смерч, Ураган, Торнадо.
- artillery: артобстріл, "арта", "обстріл" of a settlement (no flight path).
- explosion: "вибухи", "приліт", "влучання", "влучив у будинок", "чути вибух" at a named place — an impact report (also fresh damage reports: they show where it hit). Use location = the place;
  if the post replies to a tracked object and names no place, emit explosion with no location AND action "lost" for that object.
- unknown: a real flying threat whose type is not stated and not inferable from the reply chain.

WEAPON MODELS (set model only when named or unambiguous; otherwise null):
${WEAPON_LINES}

ACTIONS:
- new: first report of an object/group (not a reply about an existing one).
- update: movement/position update.
- destroyed: збито, мінус, "-1", знищено, уражено.
- lost: the object stopped being tracked: "впали", "впав", "приліт", "вибухи" right after the object's last position, "зник", "не фіксується", "без кабовозів поки". Link it to the object it ends.

ALL CLEAR (all_clear=true): "відбій", "чисто", "локаційно чисто", "ОТБОЙ ВОЗДУШНОЙ ТРЕВОГИ" for the city or oblast.

LOCATIONS — return canonical Ukrainian names in the nominative case:
- Settlements: "на Оріхів" → "Оріхів"; "в районе Васильевки" → "Василівка"; "повз Кушугум" → "Кушугум"; "До Балабиного" → "Балабине".
- Zaporizhzhia micro-districts and slang → canonical names:
  Шевчік/Шевчик/"1-2 Шевчік" → "Шевченківський район"; Космос → "Космічний"; Заводи → "Заводський район";
  Ліве → "Запоріжжя-Ліве"; ВХ → "Верхня Хортиця"; Осипок → "Осипенківський"; Бородок → "Бородинський";
  Кічкас → "Павло-Кічкас"; Дослідна → "Дослідна Станція"; мости → "Мости Преображенського"; ГЕС/гребля → "ДніпроГЕС";
  центр → "Центр міста"; аеропорт → "Аеропорт Запоріжжя"; Бабурка, Соцмісто, Півколо, Підпорожнянка, Великий Луг,
  Хортиця, Хортицький район, Леваневського, Мокрянка, Південний — as written, nominative.
- Regions: "на Дніпропетровщину" → toward "Дніпропетровська область".
- Ballistic/missiles: put the launch direction in from ("з Криму", "з Таганрогу", "з півдня" → heading S is the origin side: use from "Крим", "Азовське море", "Донецька область" as stated).
- When a post lists alternatives ("Піски/Дослідна/Космос", "МК/Кушугум/Балабине"), use the first named place as location (precision "near").
- heading = compass direction only when stated ("північно-західним курсом" → NW, "на схід" → E).
- precision: exact for a named village/landmark/micro-district, near for "в районі/неподалік/околиці" or lists, area for raions/oblast.
- Do not invent places. Leave fields null when not stated.

LINKING:
- If the message replies to a previous post, it is about the same object: reuse the parent's track id and type.
- Otherwise set track_id only when a listed active track clearly matches. Never make up ids.
- One message may describe several distinct groups → several events.

CLOSURES: "мости/греблю/ГЕС перекрито" → closures [{object, status:"closed"}]; "рух відновлено" → "open". Such a post is relevant (events may be empty).

IRRELEVANT (relevant=false, events=[]): ads, donations, "підписатися", power-outage schedules, casualty statistics and news hours after the fact, official summaries of past nights, other regions, a bare "ВОЗДУШНАЯ ТРЕВОГА" with no threat type.
NOT irrelevant: "загроза балістики", "ракетна небезпека", "швидкісна ціль" for a place — that is a ballistic event toward that place (city name → "Запоріжжя").

Confidence: 0.9 explicit and specific, 0.6 vague, 0.3 speculative ("можливо", "ймовірно").`

function formatAge(ms: number, now: number): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000))
  return `${min} хв тому`
}

export function buildUserPrompt(input: ExtractionInput): string {
  const lines: string[] = []
  lines.push(`CHANNEL: ${input.message.channelTitle} (@${input.message.channel})`)
  lines.push(`POSTED: ${formatAge(input.message.date, input.now)}`)

  if (input.activeTracks.length) {
    lines.push('', 'ACTIVE TRACKS:')
    for (const t of input.activeTracks) {
      const parts = [
        `id=${t.id}`,
        t.type,
        t.count ? `×${t.count}` : null,
        t.placeName ? `біля ${t.placeName}` : null,
        t.headingDeg !== null ? `курс ${bearingToCompassUk(t.headingDeg)}` : null,
        t.targetName ? `на ${t.targetName}` : null,
        `оновлено ${t.minutesAgo} хв тому`,
      ].filter(Boolean)
      lines.push(`- ${parts.join(', ')}`)
    }
  } else {
    lines.push('', 'ACTIVE TRACKS: none')
  }

  if (input.parents.length) {
    lines.push('', 'THIS MESSAGE REPLIES TO (nearest first):')
    input.parents.forEach((p, i) => {
      const ids = p.trackIds.length ? ` [tracks: ${p.trackIds.join(', ')}]` : ''
      lines.push(`${i + 1}. (${formatAge(p.date, input.now)})${ids} ${p.text}`)
    })
  }

  lines.push('', 'MESSAGE:', input.message.text)
  return lines.join('\n')
}
