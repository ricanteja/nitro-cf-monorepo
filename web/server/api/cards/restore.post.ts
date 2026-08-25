import type { CardRow } from '../../utils/cloudflare'
import { packEmbedding } from '../../utils/faces'

interface Snapshot {
    card: CardRow & { original_key?: string | null; ocr_text?: string | null }
    faces?: Record<string, unknown>[]
    links?: Record<string, unknown>[]
}

/**
 * Put a deleted card back exactly as it was.
 *
 * The counterpart to DELETE /api/cards/:id, and the reason that route hands back
 * a snapshot. This is what undo calls. It restores the card under its ORIGINAL
 * id, which is not a detail: a face belongs to a card id and a string joins two
 * of them, so a card that came back under a new id would come back alone.
 *
 * Everything is best-effort past the card itself. A string whose other end has
 * since been deleted cannot be restored, and refusing the whole undo over it
 * would be the wrong trade — the card is what the person asked for.
 */
export default defineEventHandler(async (event) => {
    const body = await readBody<Snapshot>(event)
    const card = body?.card
    if (!card?.id || !card.board_id) {
        throw createError({ statusCode: 400, statusMessage: 'a card snapshot is required' })
    }

    const env = useCloudflare(event)
    const board = await env.DB.prepare('SELECT id FROM boards WHERE id = ?')
        .bind(card.board_id)
        .first()
    if (!board) throw createError({ statusCode: 404, statusMessage: 'no such board' })

    const existing = await env.DB.prepare('SELECT id FROM cards WHERE id = ?').bind(card.id).first()
    if (existing) return { ok: true, restored: false }

    const now = Date.now()
    await env.DB.prepare(
        `INSERT INTO cards (id, board_id, kind, x, y, rotation, scale, z, width, height,
                            text, font_size, color, r2_key, original_key, ocr_text,
                            grid_id, grid_column, grid_row, attached_to, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
        .bind(
            card.id,
            card.board_id,
            card.kind,
            card.x,
            card.y,
            card.rotation,
            card.scale,
            card.z,
            card.width,
            card.height,
            card.text,
            card.font_size,
            card.color,
            card.r2_key,
            card.original_key ?? null,
            card.ocr_text ?? null,
            // A grid or a host card may have gone in the meantime. Both are
            // nullable and both mean "loose on the board", which is a truthful
            // place for a restored card to land.
            card.grid_id,
            card.grid_column,
            card.grid_row,
            card.attached_to,
            now,
            now
        )
        .run()

    const faces = body.faces ?? []
    if (faces.length > 0) {
        const insert = env.DB.prepare(
            'INSERT OR IGNORE INTO faces (id, card_id, person_id, x, y, w, h, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        await env.DB.batch(
            faces.map((f) =>
                insert.bind(
                    f.id,
                    card.id,
                    f.person_id ?? null,
                    f.x,
                    f.y,
                    f.w,
                    f.h,
                    // Travels as a plain array through JSON and comes back a
                    // blob; a face restored without it could never be matched
                    // again, which is a quiet way for undo to lose something.
                    packEmbedding(f.embedding as number[] | null),
                    now
                )
            )
        )
    }

    for (const link of body.links ?? []) {
        try {
            await env.DB.prepare(
                `INSERT OR IGNORE INTO links (id, board_id, from_card_id, to_card_id, color, label, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
                .bind(
                    link.id,
                    link.board_id,
                    link.from_card_id,
                    link.to_card_id,
                    link.color,
                    link.label ?? null,
                    now
                )
                .run()
        } catch {
            // The other end is gone. The string cannot exist; the card still can.
        }
    }

    await notifyBoard(env, card.board_id)
    return { ok: true, restored: true }
})
