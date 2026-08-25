/**
 * Import an image into a board from a remote URL.
 *
 * This handler does almost nothing on purpose. The cheap checks here fail an
 * obviously bad URL fast with a decent message — they are NOT the security
 * boundary. The real validation happens in the imgman container, which resolves
 * the address before connecting and re-checks every redirect hop; a Worker
 * cannot see resolved addresses at all.
 */
export default defineEventHandler(async (event) => {
    const body = await readBody<{
        url?: string
        boardId?: string
        kind?: 'image' | 'sticker'
        x?: number
        y?: number
    }>(event)
    if (!body?.url) throw createError({ statusCode: 400, statusMessage: 'missing url' })

    let parsed: URL
    try {
        parsed = new URL(body.url)
    } catch {
        throw createError({ statusCode: 400, statusMessage: 'malformed url' })
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw createError({ statusCode: 400, statusMessage: 'url must be http or https' })
    }

    if (!body.boardId) throw createError({ statusCode: 400, statusMessage: 'missing boardId' })

    const env = useCloudflare(event)
    const response = await env.IMGMAN.fetch(`http://imgman/import?board=${body.boardId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: parsed.toString() }),
    })
    const result = (await response.json()) as {
        error?: string
        width?: number
        height?: number
        originalKey?: string
        thumbnailKey?: string
        text?: string
        faces?: { x: number; y: number; w: number; h: number }[]
    }
    // The image service always answers in JSON, including when it is the one
    // that failed — so its explanation is worth passing on rather than turning
    // into a bare 502 the person importing cannot act on.
    if (!response.ok || !result.thumbnailKey) {
        throw createError({
            statusCode: response.status === 200 ? 502 : response.status,
            statusMessage: result.error || 'the image service could not fetch that URL',
        })
    }

    const kind = body.kind === 'sticker' ? 'sticker' : 'image'
    const card = await addCard(env, body.boardId, {
        kind,
        r2Key: result.thumbnailKey,
        originalKey: result.originalKey,
        ocrText: kind === 'image' ? result.text : undefined,
        faces: kind === 'image' ? result.faces : [],
        width: result.width,
        height: result.height,
        ...boardPoint(body.x, body.y),
    })
    return { card, recognised: card.recognised }
})
