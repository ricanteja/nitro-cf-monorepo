/**
 * Pin a note or a sticker to a board, or paste a copy of something already on
 * it. Images arrive through upload or import.
 *
 * The created card is returned in full, in the same shape the board read uses,
 * so the browser can put it straight onto the canvas. Re-reading the whole board
 * to discover one new card would also re-read every other card's layout, and
 * that read is a flush interval behind.
 */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const body = await readBody<{
        kind?: 'note' | 'sticker'
        copyOf?: string
        text?: string
        r2Key?: string
        x?: number
        y?: number
    }>(event)

    const env = useCloudflare(event)
    const at = boardPoint(body?.x, body?.y)

    if (body?.copyOf) {
        const card = await duplicateCard(env, boardId, body.copyOf, at)
        if (!card) throw createError({ statusCode: 404, statusMessage: 'nothing to copy' })
        return { card }
    }

    const kind = body?.kind
    if (kind !== 'note' && kind !== 'sticker') {
        throw createError({ statusCode: 400, statusMessage: 'kind must be note or sticker' })
    }
    // A sticker is either an emoji (carried in `text`) or an image cut out of
    // something already on the board (`r2Key`). One of the two is required.
    if (kind === 'sticker' && !body.text && !body.r2Key) {
        throw createError({ statusCode: 400, statusMessage: 'a sticker needs text or an r2Key' })
    }

    const card = await addCard(env, boardId, {
        kind,
        text: body.text,
        r2Key: body.r2Key,
        ...at,
    })
    return { card }
})
