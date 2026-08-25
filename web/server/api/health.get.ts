import type {
    D1Database,
    R2Bucket,
    Fetcher,
    DurableObjectNamespace,
} from '@cloudflare/workers-types'

interface SkeinBindings {
    DB?: D1Database
    R2?: R2Bucket
    IMGMAN?: Fetcher
    BOARD?: DurableObjectNamespace
}

/**
 * Binding health check.
 *
 * This answers a question that is otherwise annoying to answer: did the
 * Cloudflare bindings actually reach the running app? In development they come
 * from the monorepo preset's Miniflare instance, in production from the Workers
 * runtime, and a missing binding surfaces as `undefined` at the point of use
 * rather than as a startup error.
 *
 * So all FOUR are exercised for real rather than checked for existence — and
 * that includes the two that cost something to reach. A Durable Object is woken
 * and a container is started. Checking only the cheap two was the version of
 * this that could report "healthy" on a board that could not accept a single
 * photograph, which is worse than no check at all.
 */
async function check(name: string, run: () => Promise<string>): Promise<[string, string]> {
    try {
        return [name, await run()]
    } catch (error) {
        return [name, `ERROR ${(error as Error).message}`]
    }
}

export default defineEventHandler(async (event) => {
    const env = (cloudflareBindings(event) ?? {}) as SkeinBindings

    const probes: Promise<[string, string]>[] = [
        env.DB
            ? check('d1', async () => {
                  const row = await env.DB!.prepare('SELECT COUNT(*) AS n FROM boards').first<{
                      n: number
                  }>()
                  return `ok — ${row?.n ?? 0} board(s)`
              })
            : Promise.resolve<[string, string]>(['d1', 'MISSING binding']),

        env.R2
            ? check('r2', async () => {
                  const key = '__health'
                  await env.R2!.put(key, 'ok')
                  const object = await env.R2!.get(key)
                  const result = object ? `ok — read back "${await object.text()}"` : 'ERROR empty'
                  await env.R2!.delete(key)
                  return result
              })
            : Promise.resolve<[string, string]>(['r2', 'MISSING binding']),

        env.BOARD
            ? check('durable object', async () => {
                  // A throwaway name, so this never touches a real board's
                  // live layout — it only proves the class can be reached.
                  const stub = env.BOARD!.get(env.BOARD!.idFromName('__health'))
                  const response = await stub.fetch('http://board/state')
                  if (!response.ok) return `ERROR HTTP ${response.status}`
                  const body = (await response.json()) as { cards?: unknown[] }
                  return `ok — reachable, ${body.cards?.length ?? 0} row(s)`
              })
            : Promise.resolve<[string, string]>(['durable object', 'MISSING binding']),

        env.IMGMAN
            ? check('container', async () => {
                  const response = await env.IMGMAN!.fetch('http://imgman/health')
                  if (!response.ok) return `ERROR HTTP ${response.status}`
                  const body = (await response.json()) as {
                      ok?: boolean
                      tools?: Record<string, boolean>
                  }
                  const tools = Object.entries(body.tools ?? {})
                  // The container reports each native tool by RUNNING it, so a
                  // false here means the binary is present and broken.
                  const broken = tools.filter(([, works]) => !works).map(([name]) => name)
                  if (broken.length > 0) return `ERROR cannot run ${broken.join(', ')}`
                  return `ok — ${tools.length} native tool(s)`
              })
            : Promise.resolve<[string, string]>(['container', 'MISSING binding']),
    ]

    const checks = Object.fromEntries(await Promise.all(probes))
    return {
        bindings: Object.keys(env).sort(),
        checks,
        healthy: Object.values(checks).every((v) => v.startsWith('ok')),
    }
})
