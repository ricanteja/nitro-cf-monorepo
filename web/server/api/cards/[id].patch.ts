/**
 * Update a card.
 *
 * Two paths, deliberately. LAYOUT — position, rotation, scale, stacking,
 * snapping — goes through the board's Durable Object, which is authoritative
 * while a session is open, broadcasts to everyone watching, and flushes to D1
 * on its own schedule; writing it here too would race that flush. CONTENT —
 * a note's text, size and colour — is not layout, so it goes straight to D1 and
 * the object is told to relay it.
 */
const LAYOUT_KEYS = [
    'x',
    'y',
    'rotation',
    'scale',
    'z',
    'gridId',
    'gridColumn',
    'gridRow',
    'attachedTo',
] as const

export default defineEventHandler(async (event) => {
    const cardId = getRouterParam(event, 'id')
    if (!cardId) throw createError({ statusCode: 400, statusMessage: 'missing card id' })

    const body = await readBody<Record<string, unknown>>(event)
    const env = useCloudflare(event)

    const owner = await env.DB.prepare('SELECT board_id AS boardId FROM cards WHERE id = ?')
        .bind(cardId)
        .first<{ boardId: string }>()
    if (!owner) throw createError({ statusCode: 404, statusMessage: 'no such card' })

    const layout = Object.fromEntries(
        LAYOUT_KEYS.filter((k) => body?.[k] !== undefined).map((k) => [k, body[k]])
    )

    const content: Record<string, unknown> = {}
    if (typeof body?.text === 'string') {
        if (body.text.length > 4000) {
            throw createError({ statusCode: 400, statusMessage: 'note is too long' })
        }
        content.text = body.text
    }
    if (typeof body?.fontSize === 'number') content.font_size = body.fontSize
    if (typeof body?.color === 'string' || body?.color === null) content.color = body.color

    if (Object.keys(content).length > 0) {
        const sets = Object.keys(content).map((k) => `${k} = ?`)
        await env.DB.prepare(`UPDATE cards SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`)
            .bind(...Object.values(content), Date.now(), cardId)
            .run()
    }

    const stub = env.BOARD.get(env.BOARD.idFromName(owner.boardId))
    if (Object.keys(layout).length > 0) {
        const response = await stub.fetch('http://board/move', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: cardId, ...layout, actor: body?.actor ?? null }),
        })
        if (!response.ok) {
            throw createError({ statusCode: 502, statusMessage: 'board service rejected the move' })
        }
    } else if (Object.keys(content).length > 0) {
        await stub.fetch('http://board/relay', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'card:content',
                id: cardId,
                ...content,
                actor: body?.actor ?? null,
            }),
        })
    }

    return { ok: true }
})
