import { THREAT_TYPES, type ThreatType, WEAPON_IDS } from '@arpha/shared'
import { z } from 'zod'

/** A channel post, normalized away from the Telegram client library. */
export interface RawMessage {
  /** Channel username (without @) or numeric id as string. */
  channel: string
  channelTitle: string
  id: number
  /** Epoch ms. */
  date: number
  editDate: number | null
  text: string
  replyToId: number | null
}

export const ACTIONS = ['new', 'update', 'destroyed', 'lost'] as const
export const PRECISIONS = ['exact', 'near', 'area'] as const
export const HEADINGS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

export type EventAction = (typeof ACTIONS)[number]

const nullableString = z
  .string()
  .nullish()
  .transform((v) => (v?.trim() ? v.trim() : null))

/**
 * Validation of the model's tool input. Lenient on shape (nulls vs missing,
 * numbers as strings) but strict on vocabulary, so a hallucinated enum value
 * degrades to a safe default instead of breaking the pipeline.
 */
export const extractedEventSchema = z.object({
  type: z.enum(THREAT_TYPES).catch('unknown'),
  model: z
    .enum(WEAPON_IDS as [string, ...string[]])
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  count: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  action: z.enum(ACTIONS).catch('update'),
  location: nullableString,
  precision: z
    .enum(PRECISIONS)
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  from: nullableString,
  toward: nullableString,
  heading: z
    .enum(HEADINGS)
    .nullish()
    .catch(null)
    .transform((v) => v ?? null),
  track_id: nullableString,
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
})

export const closureSchema = z.object({
  object: z.string().min(2),
  status: z.enum(['closed', 'open']),
})

export const extractionSchema = z.object({
  relevant: z.boolean().catch(false),
  all_clear: z.boolean().catch(false),
  closures: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = closureSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }),
    ),
  events: z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = extractedEventSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      }),
    ),
})

export type ExtractedEvent = z.infer<typeof extractedEventSchema>
export type Extraction = z.infer<typeof extractionSchema>

/** What the model sees about currently tracked objects, to link follow-ups. */
export interface TrackBrief {
  id: string
  type: ThreatType
  count: number | null
  placeName: string | null
  headingDeg: number | null
  targetName: string | null
  minutesAgo: number
}

export interface ParentMessage {
  text: string
  date: number
  trackIds: string[]
}

export interface ExtractionInput {
  message: RawMessage
  /** Reply chain, nearest parent first. */
  parents: ParentMessage[]
  activeTracks: TrackBrief[]
  now: number
}

export interface Extractor {
  extract(input: ExtractionInput): Promise<Extraction>
}

export const EMPTY_EXTRACTION: Extraction = {
  relevant: false,
  all_clear: false,
  closures: [],
  events: [],
}
