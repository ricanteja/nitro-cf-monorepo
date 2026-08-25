/** Create a board. A fresh checkout has an empty database, so this is what makes the app usable. */
export default defineEventHandler(async (event) => {
    const body = await readBody<{ title?: string }>(event)
    const title = (body?.title ?? '').trim() || 'Untitled board'
    if (title.length > 120)
        throw createError({ statusCode: 400, statusMessage: 'title is too long' })

    const { DB } = useCloudflare(event)
    const id = crypto.randomUUID()
    const now = Date.now()
    await DB.prepare('INSERT INTO boards (id, title, created_at) VALUES (?, ?, ?)')
        .bind(id, title, now)
        .run()
    return { id, title, created_at: now, card_count: 0 }
})
