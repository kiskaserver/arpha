import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Vitest resolves modules through Vite, which forgives CommonJS deep imports
 * like `telegram/events`. Production runs plain Node ESM, which does not —
 * that once crashed the deploy. Import every external specifier with real Node.
 */
const root = resolve(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? sources(join(dir, e.name))
      : e.name.endsWith('.ts')
        ? [join(dir, e.name)]
        : [],
  )
}

const specifiers = [
  ...new Set(
    sources(join(root, 'src')).flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/^import\s+(?!type\b)[^'"]*from\s+'([^'.][^']*)'/gm)]
        .map((m) => m[1]!)
        .filter((s) => !s.startsWith('@arpha/')),
    ),
  ),
].sort()

describe('runtime ESM imports', () => {
  it('finds the external dependencies', () => {
    expect(specifiers).toContain('telegram')
    expect(specifiers.some((s) => s.startsWith('telegram/'))).toBe(true)
  })

  it('every external import loads under plain Node ESM', () => {
    const script = `for (const s of ${JSON.stringify(specifiers)}) {
      try { await import(s) } catch (e) { console.log(s + ': ' + e.code); process.exitCode = 1 }
    }`
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      encoding: 'utf8',
    })
    expect(out).toBe('')
  }, 30_000)
})
