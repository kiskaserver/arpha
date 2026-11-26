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
            altitude_m: {
              type: ['integer', 'null'],
              description: 'Altitude in metres when stated ("Висота 700", "500м висота").',
            },
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
  Кічкас → "Павло-Кічкас"; МК → "Малокатеринівка"; ДД → "Селище ДД"; Острів → "Хортиця";
  Дослідна → "Дослідна Станція"; мости → "Мости Преображенського"; ГЕС/гребля → "ДніпроГЕС";
  центр → "Центр міста"; аеропорт → "Аеропорт Запоріжжя"; Бабурка, Соцмісто, Півколо, Підпорожнянка, Великий Луг,
  Хортиця, Хортицький район, Леваневського, Мокрянка, Південний — as written, nominative.
- Regions: "на Дніпропетровщину" → toward "Дніпропетровська область".
- Ballistic/missiles: put the launch direction in from ("з Криму", "з Таганрогу", "з півдня" → heading S is the origin side: use from "Крим", "Азовське море", "Донецька область" as stated).
- When a post lists alternatives ("Піски/Дослідна/Космос", "МК/Кушугум/Балабине"), use the first named place as location (precision "near"). Alternatives joined by "/" are ONE object, never several events.
- Per-line lists ("1 Заводи ⏎ 1 до Аеропорту ⏎ 1 Українка", "По реактивних: 1 … 1 … 1 …") are SEPARATE objects: exactly one event per line, in order. A bare place on a line = location; "до X"/"на X" on a line = toward X.
- Шевченківське (a village east of the city, next to Григорівське) is NOT Шевченківський район (the city district, "Шевчик").
- "ще", "ще один", "ще N", "ще пара" (пара = 2), "Щонайменше N ще", "Другий …" = MORE objects: action new, never an update of
  the group already reported. With no type in the post, they are of the same type as what the thread / the channel's
  active tracks are about ("4 шахеда на …" then "Ще 3 від …" → 3 more shaheds, not jets).
- "Вже N", "N над X", "Група з N" in a reply = the count (and place) of that group: action update with count.
- "Всі до X", "всі на X" = the thread's objects heading to X: ONE update event with toward X. Never "lost".
- lost/destroyed only for an object THIS post says ended ("без фіксації", "зник", "впав", "мінус", "збили").
  "Вибухи в X", "гучно", "приліт" alone = one explosion event (location X if named); do not end tracked objects with it.
- Future or expected ("зараз в'єбуть", "можуть", "буде", "ще будуть залітати") is not an explosion and not an event.
- "N БпЛА", "група БпЛА" in an attack = shahed; recon_drone only for Орлан, Зала, Суперкам, Мавік, "розвідник".
- "Останні N на X", "N на X", "N до X" = toward X (not location).
- "Чисто", "По БпЛА чисто", "Без фіксації", "Не фіксується" in a REPLY = the thread's object ended: one event, action lost.
  Standalone "Відбій"/"Локаційно чисто" for the city or oblast = all_clear (see ALL CLEAR).
- "західніше/східніше/північніше/південніше X", "околиці X", "в районі X" → location X with precision near — never put
  the direction word into the name.
- "чисто, але може бути…", "можливо ще…" without a sighting = no event.
- heading = compass direction only when stated ("північно-західним курсом" → NW, "на схід" → E).
- precision: exact for a named village/landmark/micro-district, near for "в районі/неподалік/околиці" or lists, area for raions/oblast.
- Do not invent places. Leave fields null when not stated.
- location is only a place THIS post names as the current position. A reply that only gives a new course
  ("Довернув на X", "Далі курсом на X", "На X") has location null and toward X — never repeat the parent's place.
- A local name or abbreviation you do not recognise: return it exactly as written ("Гортоп", "Кар'єри", "ДД").
  Never expand it into a name you made up, and never replace it with "Запоріжжя".
- "з півночі", "з півдня", "зі сходу", "з заходу" are directions, not places: heading S, N, W, E; from null.
- ALTITUDE: "Висота 700", "500м висота", "знизився до 600м" → altitude_m. A reply with only an altitude is an
  update of the same object with altitude_m set.

LINKING:
- If the message replies to a previous post, it is about the same object: reuse the parent's track id and type.
- Otherwise set track_id only when a listed active track clearly matches. Never make up ids.
- One message may describe several distinct groups → several events.

CLOSURES: "мости/греблю/ГЕС перекрито" → closures [{object, status:"closed"}]; "рух відновлено" → "open". Such a post is relevant (events may be empty).

IRRELEVANT (relevant=false, events=[]): ads, donations, "підписатися", power-outage schedules, casualty statistics and news hours after the fact, official summaries of past nights, other regions, a bare "ВОЗДУШНАЯ ТРЕВОГА" with no threat type.
NOT irrelevant: "загроза балістики", "ракетна небезпека", "швидкісна ціль" for a place — that is a ballistic event toward that place (city name → "Запоріжжя").

Confidence: 0.9 explicit and specific, 0.6 vague, 0.3 speculative ("можливо", "ймовірно").

EXAMPLES (post → report; fields not shown are null, count 1, action new, confidence 0.9):
1. "2 мопеди від Пологів курсом на Оріхів" → events [{type:shahed, count:2, from:"Пологи", toward:"Оріхів"}]
2. Reply to a post linked to track t1 ("Шахед на Комишуваху"): "Комишуваха, далі на Новоолександрівку"
   → [{type:shahed, action:update, location:"Комишуваха", toward:"Новоолександрівка", track_id:"t1"}]
3. "Реактив над Хортицею, курс північ" → [{type:jet_drone, model:"geran_3", location:"Хортиця", heading:"N"}]
4. "1 шахед на Кушугум, ще 2 — на Балабине" → two groups:
   [{type:shahed, toward:"Кушугум"}, {type:shahed, count:2, toward:"Балабине"}]
5. "Пуски КАБ по Гуляйполю 💣" → [{type:kab, model:"umpk_fab500", location:"Гуляйполе"}] (launches "на/по X" = the strike area)
6. "Кабовози активні на південному напрямку" → [{type:aircraft, confidence:0.6}]
7. Reply to track t2 ("Молнія на Степове"): "Збили над Степовим 🔥" → [{type:molniya, action:destroyed, location:"Степове", track_id:"t2"}]
8. Reply to track t3: "Зник з радарів" → [{type:<t3's type>, action:lost, track_id:"t3"}]
9. "Швидкісна ціль з Бердянська на Запоріжжя!" → [{type:ballistic, from:"Бердянськ", toward:"Запоріжжя"}]
10. "Х-59 з Азовського моря курсом на Запоріжжя" → [{type:cruise_missile, model:"kh_59", from:"Азовське море", toward:"Запоріжжя"}]
11. "Орлан кружляє над Степногірськом" → [{type:recon_drone, model:"orlan_10", location:"Степногірськ"}]
12. "Град по Приморському 🚀" → [{type:mlrs, toward:"Приморське"}]
13. "Приліт у Вільнянську, без деталей" → [{type:explosion, location:"Вільнянськ"}]
14. "ФПВшка в районі Матвіївки, можливо на Вільнянськ" → [{type:fpv, location:"Матвіївка", precision:near, toward:"Вільнянськ", confidence:0.3}]
15. "Над Шевчиком і Бородком по одному мопеду" → [{type:shahed, location:"Шевченківський район"}, {type:shahed, location:"Бородинський"}]
16. "Відбій. Локаційно чисто 🟢" → relevant:true, all_clear:true, events []
17. "Світло з 18:00 по 22:00, черга 3.1" → relevant:false, events []
18. "Ранкове зведення: за добу 12 обстрілів по області" → relevant:false (a past summary), events []
19. Reply to track t4 ("Реактив над Вільнянськом"): "Довернув на Новософіївку" → [{type:jet_drone, action:update, toward:"Новософіївка", track_id:"t4"}] (location null)
20. Reply to track t4: "Ліве над вами ⏎ Висота 700" (⏎ = a line break) → [{type:jet_drone, action:update, location:"Запоріжжя-Ліве", altitude_m:700, track_id:"t4"}]
21. "Новий реактив з півночі до Новомиколаївки" → [{type:jet_drone, heading:"S", toward:"Новомиколаївка"}]
22. Reply to a post about three jets: "1 Ясна Поляна ⏎ 1 до Тарасівки ⏎ 1 до Широкого" → three events:
   [{type:jet_drone, action:update, location:"Ясна Поляна"}, {type:jet_drone, action:update, toward:"Тарасівка"}, {type:jet_drone, action:update, toward:"Широке"}]
23. Reply to track t5: "Скворцова/ДД" → one event [{type:jet_drone, action:update, location:"Скворцова", precision:near, track_id:"t5"}]
24. After "4 шахеда на Новослобідку": "Ще 3 від Новосергіївки в бік Хортицького" → [{type:shahed, action:new, count:3, from:"Новосергіївка", toward:"Хортицький район"}]
25. "Повз Біленьке ще шахед в напрямку Новосергіївки" → [{type:shahed, action:new, location:"Біленьке", toward:"Новосергіївка"}]
26. Reply to a post about three shaheds: "Всі до Хортицького/ВХ" → [{type:shahed, action:update, toward:"Хортицький район"}] (one event)
27. "Вибухи в Запоріжжі" → [{type:explosion, location:"Запоріжжя"}] (one event, nothing ends)`

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
