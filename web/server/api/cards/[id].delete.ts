import { unpackEmbedding, type StoredBlob } from '../../utils/faces'

/**
 * Remove a card, and hand back enough to put it back.
 *
 * The R2 objects are DELIBERATELY LEFT ALONE. Deleting a card is undoable, and
 * an undo that restored a photograph as a broken image would be worse than no
 * undo at all — bytes are the one thing that cannot be reconstructed from a
 * snapshot. The board owns its objects and sweeps them by prefix when the board
 * itself is deleted, which is the point at which nothing is coming back.
 *
 * The response carries the card, its faces and its strings, because all three go
 * with it: D1 cascades faces and links off the card, so restoring the row alone
 * would bring back a photograph with nobody in it and nothing attached to it.
 */
export default defineEventHandler(async (event) => {
    const cardId = getRouterParam(event, 'id')
    if (!cardId) throw createError({ statusCode: 400, statusMessage: 'missing card id' })

    const env = useCloudflare(event)
    const card = await env.DB.prepare(
        `SELECT ${CARD_COLUMNS}, original_key, ocr_text FROM cards WHERE id = ?`
    )
        .bind(cardId)
        .first<CardRow & { original_key: string | null; ocr_text: string | null }>()
    if (!card) throw createError({ statusCode: 404, statusMessage: 'no such card' })

    // Layout is only in D1 as of the last flush, so a snapshot taken from the
    // table alone would restore the card where it was several seconds ago.
    const live = await liveLayout(env, card.board_id)
    const snapshot = { ...card, ...(live.get(cardId) ?? {}) }

    const [faces, links] = await Promise.all([
        env.DB.prepare('SELECT id, person_id, x, y, w, h, embedding FROM faces WHERE card_id = ?')
            .bind(cardId)
            .all<Record<string, unknown>>(),
        env.DB.prepare(
            `SELECT id, board_id, from_card_id, to_card_id, color, label
               FROM links WHERE from_card_id = ? OR to_card_id = ?`
        )
            .bind(cardId, cardId)
            .all<Record<string, unknown>>(),
    ])

    await env.DB.prepare('DELETE FROM cards WHERE id = ?').bind(cardId).run()
    await notifyBoard(env, card.board_id)

    // Embeddings come out of D1 as blobs and the snapshot travels as JSON, where
    // an ArrayBuffer serialises to `{}` — so they are unpacked into plain
    // numbers on the way out and packed again on restore. Skipping this loses
    // the recognition data silently: the face comes back, and it can never be
    // matched to anybody again.
    const restorableFaces = faces.results.map((face) => ({
        ...face,
        embedding: Array.from(unpackEmbedding(face.embedding as StoredBlob) ?? []),
    }))

    return {
        ok: true,
        snapshot: { card: snapshot, faces: restorableFaces, links: links.results },
    }
})
