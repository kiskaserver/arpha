/**
 * Generate a VAPID key pair for Web Push.
 *
 *   pnpm push:keys
 */
import * as webpush from 'web-push'

const { publicKey, privateKey } = webpush.generateVAPIDKeys()
console.log(`VAPID_PUBLIC_KEY=${publicKey}`)
console.log(`VAPID_PRIVATE_KEY=${privateKey}`)
console.log('VAPID_SUBJECT=mailto:you@example.com')
