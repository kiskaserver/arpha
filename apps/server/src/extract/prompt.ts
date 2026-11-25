import { bearingToCompassUk, THREAT_TYPES } from '@arpha/shared'
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

export const SYSTEM_PROMPT = `You convert Ukrainian/Russian Telegram air-raid monitoring posts about Zaporizhzhia city and oblast into structured threat events. Posts are informal, abbreviated, full of slang and emoji, and often reply to an earlier post about the same object.

THREAT TYPES (pick the most specific):
- shahed: шахед, шахєд, герань/герани, мопед, газонокосарка, "ударні БпЛА", "БпЛА типу Shahed", "дрон-камікадзе", "бпла" when attack drones are implied.
- jet_drone: реактивний шахед, Герань-3, "реактивний БпЛА", "реактив".
- cruise_missile: крилата ракета, КР, Калібр, Х-101, Х-555, Х-59, Х-69, "ракета курсом на…" with a flight path.
- ballistic: балістика, Іскандер, КН-23, С-300/С-400 по наземних цілях, "загроза балістики", "швидкісна ціль".
- kab: КАБ, КАБи, керовані авіабомби, УМПК, ФАБ з УМПК, "пуски КАБ".
- recon_drone: розвідник, розвідувальний БпЛА, Орлан, Зала, Суперкам, Мавік.
- aircraft: тактична авіація, Су-34, Су-35, Су-25, "активність авіації", борт.
- helicopter: гелікоптер, вертоліт, Ка-52, Мі-8.
- mlrs: РСЗВ, Град, Смерч, Ураган, Торнадо, "обстріл з РСЗВ".
- unknown: a real flying threat whose type is not stated.

ACTIONS:
- new: first report of an object/group.
- update: movement/position update of a known or newly mentioned object.
- destroyed: збито, мінус, "-1", знищено, уражено, "відпрацювала ППО успішно" (for a specific object).
- lost: "зник з радарів", "не фіксується", "втрачено".

LOCATIONS:
- Always return names in Ukrainian, nominative case: "на Оріхів" → "Оріхів"; "в районе Васильевки" → "Василівка"; "повз Кушугум" → "Кушугум".
- location = where it is now ("в районі", "над", "біля", "повз", "фіксується", "в напрямку … зараз в …").
- from = origin ("з боку", "від", "з", "з півдня" → use heading instead if only a direction).
- toward = destination ("курсом на", "на", "в напрямку").
- heading = compass direction when stated ("північно-західним курсом" → NW, "рухається на схід" → E, "з півдня на північ" → N).
- precision: exact for a named village/landmark, near for "в районі/неподалік", area for raions/oblast/"південь області".
- City districts of Zaporizhzhia are valid locations: "Шевченківський район", "Хортицький район", "Хортиця", "ДніпроГЕС".
- Do not invent locations. Leave fields null when not stated.

LINKING:
- If the message replies to a previous post, it is almost always about the same object(s): reuse its track id.
- If a listed active track clearly matches (same type, consistent place/course), set track_id. Never make up ids.
- One message may describe several distinct groups → several events.

IRRELEVANT (relevant=false, events=[]): ads, donations, polls, chatter, official summaries of past nights ("за ніч збито 50"), news about other regions, explosions reports without a threat object, warnings with no threat.

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
