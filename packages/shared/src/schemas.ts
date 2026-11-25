import { z } from 'zod'
import { THREAT_CLASSES } from './threats'

/** Kept apart from the main entry so the web bundle never pulls in zod. */
const point = z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) })

export const pushSubscriptionSchema = z
  .object({
    subscription: z.object({
      endpoint: z.url().max(2048),
      expirationTime: z.number().nullable().optional(),
      keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
    }),
    /** Named places to watch ("Дім", "Робота"). */
    points: z
      .array(point.extend({ name: z.string().trim().min(1).max(40) }))
      .max(5)
      .default([]),
    /** Legacy single point. */
    point: point.nullable().optional(),
    radiusKm: z.number().min(1).max(100).default(15),
    alerts: z.boolean().default(true),
    threats: z.boolean().default(true),
    classes: z.array(z.enum(THREAT_CLASSES)).default([...THREAT_CLASSES]),
  })
  .transform(({ point: legacy, ...rest }) => ({
    ...rest,
    points: rest.points.length || !legacy ? rest.points : [{ ...legacy, name: 'Моя точка' }],
  }))

export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>
