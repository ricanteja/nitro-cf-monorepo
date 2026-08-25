/** Move, resize, retitle or restructure a table. */
export default defineEventHandler(async (event) => {
    const id = getRouterParam(event, 'id')
    if (!id) throw createError({ statusCode: 400, statusMessage: 'missing grid id' })
    const body = await readBody<Record<string, unknown>>(event)
    const env = useCloudflare(event)

    const grid = await env.DB.prepare('SELECT board_id AS boardId FROM grids WHERE id = ?')
        .bind(id)
        .first<{ boardId: string }>()
    if (!grid) throw createError({ statusCode: 404, statusMessage: 'no such grid' })

    const sets: string[] = []
    const values: unknown[] = []
    for (const [key, column] of [
        ['x', 'x'],
        ['y', 'y'],
        ['width', 'width'],
        ['height', 'height'],
        ['title', 'title'],
    ] as const) {
        if (body?.[key] !== undefined) {
            sets.push(`${column} = ?`)
            values.push(body[key])
        }
    }
    // Columns and rows arrive as arrays and are stored as JSON.
    for (const key of ['columns', 'rows'] as const) {
        if (Array.isArray(body?.[key])) {
            sets.push(`${key} = ?`)
            values.push(JSON.stringify(body[key]))
        }
    }
    if (sets.length === 0) return { ok: true }

    await env.DB.prepare(`UPDATE grids SET ${sets.join(', ')} WHERE id = ?`)
        .bind(...values, id)
        .run()
    await notifyBoard(env, grid.boardId)
    return { ok: true }
})
