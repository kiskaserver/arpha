import * as webpush from 'web-push'
import { PushGoneError, type PushPayload, type PushSender } from './service'

export function createWebPushSender(opts: {
  publicKey: string
  privateKey: string
  subject: string
}): PushSender {
  webpush.setVapidDetails(opts.subject, opts.publicKey, opts.privateKey)
  return async (sub, payload: PushPayload) => {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 600, urgency: 'high' })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) throw new PushGoneError(`subscription gone (${status})`)
      throw err
    }
  }
}
