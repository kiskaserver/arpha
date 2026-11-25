import { z } from 'zod'

/** Kept apart from the main entry so the web bundle never pulls in zod. */
export const pushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.url().max(2048),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
  }),
  point: z
    .object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })
    .nullable(),
  radiusKm: z.number().min(1).max(100).default(15),
  alerts: z.boolean().default(true),
  threats: z.boolean().default(true),
})

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>
