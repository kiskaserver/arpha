import type { RawMessage } from '../extract/types'

/** The fields we read from a teleproto (GramJS-compatible) `Api.Message`, so mapping is testable without the library. */
export interface GramMessageLike {
  id: number
  /** Unix seconds. */
  date: number
  editDate?: number | null
  message?: string | null
  replyTo?: { replyToMsgId?: number | null; quoteText?: string | null } | null
}

export interface ChannelInfo {
  key: string
  title: string
}

export function toRawMessage(m: GramMessageLike, channel: ChannelInfo): RawMessage {
  return {
    channel: channel.key,
    channelTitle: channel.title,
    id: m.id,
    date: m.date * 1000,
    editDate: m.editDate ? m.editDate * 1000 : null,
    text: m.message ?? '',
    replyToId: m.replyTo?.replyToMsgId ?? null,
    quoteText: m.replyTo?.quoteText?.trim() || null,
  }
}

/** Normalize a configured channel reference to a stable key. */
export function channelKey(ref: string): string {
  return ref
    .trim()
    .replace(/^https?:\/\/t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/$/, '')
    .toLowerCase()
}
