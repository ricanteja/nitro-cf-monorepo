/**
 * Upload an image or PDF straight from the browser.
 *
 * The counterpart to /api/import: same container, same pipeline, different
 * intake. Here the caller already holds the bytes, so they go to imgman's
 * /process rather than having the container fetch them.
 *
 * The body is the file, so everything else travels in the query string: where
 * on the board it should land, and whether it becomes a photograph or a sticker.
 */
export default defineEventHandler(async (event) => {
    const boardId = getRouterParam(event, 'id')
    if (!boardId) throw createError({ statusCode: 400, statusMessage: 'missing board id' })

    const bytes = await readRawBody(event, false)
    if (!bytes || bytes.length === 0) {
        throw createError({ statusCode: 400, statusMessage: 'empty upload' })
    }

    const query = getQuery(event)
    const kind = query.kind === 'sticker' ? 'sticker' : 'image'
    const at = boardPoint(query.x, query.y)

    const env = useCloudflare(event)
    const response = await env.IMGMAN.fetch(`http://imgman/process?board=${boardId}`, {
        method: 'POST',
        // A plain byte view, not the Node Buffer readRawBody returns: the DOM
        // and workers-types each declare their own ReadableStream, so the
        // BodyInit unions do not unify across the binding.
        body: new Uint8Array(bytes),
    })
    const result = (await response.json()) as {
        error?: string
        format?: string
        width?: number
        height?: number
        originalKey?: string
        thumbnailKey?: string
        text?: string
        faces?: { x: number; y: number; w: number; h: number }[]
    }
    // The image service always answers in JSON, including when it is the one
    // that failed — so its explanation is worth passing on rather than turning
    // into a bare 502 the person uploading cannot act on.
    if (!response.ok || !result.thumbnailKey) {
        throw createError({
            statusCode: response.status === 200 ? 502 : response.status,
            statusMessage: result.error || 'the image service could not handle that file',
        })
    }

    const card = await addCard(env, boardId, {
        kind,
        // The THUMBNAIL key, because that is what the board renders. The
        // original stays in R2 for cut-outs and future edit steps.
        r2Key: result.thumbnailKey,
        originalKey: result.originalKey,
        // A sticker is a cut-out, not a document: reading text off it would put
        // it in the search index as if it were something to find.
        ocrText: kind === 'image' ? result.text : undefined,
        faces: kind === 'image' ? result.faces : [],
        width: result.width,
        height: result.height,
        ...at,
    })

    return {
        card,
        recognised: card.recognised,
        storage: {
            format: result.format,
            width: result.width,
            height: result.height,
            thumbnailKey: result.thumbnailKey,
        },
    }
})
