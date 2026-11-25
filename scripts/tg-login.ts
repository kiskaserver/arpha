/**
 * One-time interactive Telegram login. Prints a StringSession for TG_SESSION.
 *
 *   pnpm tg:login
 *
 * Needs TG_API_ID and TG_API_HASH (https://my.telegram.org → API development tools),
 * from .env or the environment. Nothing is written to disk.
 */
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { TelegramClient } from 'telegram'
import { LogLevel } from 'telegram/extensions/Logger.js'
import { StringSession } from 'telegram/sessions/index.js'

process.loadEnvFile?.('.env')

const rl = createInterface({ input, output })
const apiId = Number(process.env.TG_API_ID || (await rl.question('TG_API_ID: ')))
const apiHash = process.env.TG_API_HASH || (await rl.question('TG_API_HASH: '))

const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 })
client.setLogLevel(LogLevel.ERROR)

await client.start({
  phoneNumber: () => rl.question('Номер телефону (+380…): '),
  phoneCode: () => rl.question('Код з Telegram: '),
  password: () => rl.question('Пароль 2FA (якщо є): '),
  onError: (err) => console.error(err.message),
})

const me = await client.getMe()
console.log(
  `\n✅ Увійшли як ${'firstName' in me ? me.firstName : ''} (@${'username' in me ? me.username : '—'})`,
)
console.log('\nДодайте у змінні середовища (Railway → Variables), НЕ комітьте:\n')
console.log(`TG_SESSION=${client.session.save()}\n`)
console.log('⚠️  Цей рядок дає повний доступ до акаунта. Тримайте його в секреті.')
rl.close()
await client.disconnect()
process.exit(0)
