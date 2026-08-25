import type { CardRow, SkeinEnv } from './cloudflare'
import { matchFace, namedFaces, packEmbedding, unpackEmbedding } from './faces'

export interface DetectedFace {
    x: number
    y: number
    w: number
    h: number
    score?: number
    /** 128 numbers describing the face, or null when it could not be aligned. */
    embedding?: number[] | null
}

export interface NewCard {
    kind: 'note' | 'image' | 'sticker'
    text?: string
    r2Key?: string
    originalKey?: string
    ocrText?: string
    faces?: DetectedFace[]
    width?: number | null
    height?: number | null
    x?: number
    y?: number
    /**
     * Appearance carried over from somewhere else — a paste, in practice.
     *
     * Absent for a genuinely new card, which gets the defaults below: scale 1,
     * no colour, and the small random tilt that makes a board look pinned rather
     * than laid out.
     */
    rotation?: number
    scale?: number
    color?: string | null
    fontSize?: number | null
}

/**
 * The columns the client works with, in one place.
 *
 * Every route that hands a card back uses this list, so a card created by an
 * upload has exactly the same shape as one read back on load — which is what
 * lets the browser append a new card instead of reloading the whole board.
 */
export const CARD_COLUMNS = `id, board_id, kind, x, y, rotation, scale, z, width, height,
                             text, font_size, color, r2_key, grid_id, grid_column, grid_row,
                             attached_to`

/**
 * Placement grid for new cards. Roughly one image-width apart, so a board with
 * a handful of things on it reads as a board rather than a heap — and a heap
 * hides the strings between them, which are the point.
 */
const COLUMNS = 4
const COLUMN_WIDTH_PX = 300
const ROW_HEIGHT_PX = 250
const MARGIN_PX = 80
const JITTER_PX = 26

/**
 * Nudge a new card off anything already sitting exactly there.
 *
 * Cards land where the user is looking, so adding two notes without moving the
 * first one used to stack them precisely — one card, apparently, until you
 * dragged it and found another underneath. Cascading is what every application
 * that opens things in the same place does, and it makes "I added two" visible
 * without inventing a layout the user did not ask for.
 */
const CASCADE_STEP_PX = 26
const CASCADE_LIMIT = 12

async function cascade(
    env: SkeinEnv,
    boardId: string,
    at: { x: number; y: number }
): Promise<{ x: number; y: number }> {
    // Tables count as occupants too. Adding a table and then a note put both
    // at the middle of the viewport, so the note landed exactly on the table's
    // title bar and looked like part of it.
    const { results } = await env.DB.prepare(
        `SELECT x, y FROM cards WHERE board_id = ? AND ABS(x - ?) < 400 AND ABS(y - ?) < 400
         UNION ALL
         SELECT x, y FROM grids WHERE board_id = ? AND ABS(x - ?) < 400 AND ABS(y - ?) < 400`
    )
        .bind(boardId, at.x, at.y, boardId, at.x, at.y)
        .all<{ x: number; y: number }>()
    if (results.length === 0) return at

    let { x, y } = at
    for (let step = 0; step < CASCADE_LIMIT; step++) {
        const clash = results.some((r) => Math.abs(r.x - x) < 8 && Math.abs(r.y - y) < 8)
        if (!clash) break
        x += CASCADE_STEP_PX
        y += CASCADE_STEP_PX
    }
    return {
        x: Math.min(BOARD_WIDTH - 40, x),
        y: Math.min(BOARD_HEIGHT - 40, y),
    }
}

/** A card as stored, plus who was recognised in it on the way in. */
export interface AddedCard extends CardRow {
    /** Names matched automatically against faces already labelled on this board. */
    recognised: string[]
}

export async function addCard(env: SkeinEnv, boardId: string, spec: NewCard): Promise<AddedCard> {
    const top = await env.DB.prepare(
        'SELECT COALESCE(MAX(z), 0) + 1 AS next, COUNT(*) AS placed FROM cards WHERE board_id = ?'
    )
        .bind(boardId)
        .first<{ next: number; placed: number }>()

    const placed = top?.placed ?? 0
    const jitter = () => Math.round((Math.random() - 0.5) * 2 * JITTER_PX)
    const requested = {
        x: spec.x ?? MARGIN_PX + (placed % COLUMNS) * COLUMN_WIDTH_PX + jitter(),
        y: spec.y ?? MARGIN_PX + Math.floor(placed / COLUMNS) * ROW_HEIGHT_PX + jitter(),
    }
    const { x, y } = await cascade(env, boardId, requested)
    const rotation =
        spec.rotation ??
        (spec.kind === 'sticker' ? 0 : Math.round((Math.random() * 8 - 4) * 10) / 10)
    const scale = spec.scale ?? 1

    const id = crypto.randomUUID()
    const now = Date.now()
    const z = top?.next ?? 1

    const text = spec.kind === 'image' ? null : (spec.text ?? '')
    const color = spec.color ?? null
    const fontSize = spec.fontSize ?? null
    const r2Key = spec.kind === 'note' ? null : (spec.r2Key ?? null)
    const originalKey = spec.kind === 'note' ? null : (spec.originalKey ?? null)

    await env.DB.prepare(
        `INSERT INTO cards (id, board_id, kind, x, y, rotation, scale, z, width, height,
                            text, font_size, color, r2_key, original_key, ocr_text,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
        .bind(
            id,
            boardId,
            spec.kind,
            x,
            y,
            rotation,
            scale,
            z,
            spec.width ?? null,
            spec.height ?? null,
            text,
            fontSize,
            color,
            r2Key,
            originalKey,
            spec.ocrText?.trim() || null,
            now,
            now
        )
        .run()

    // Faces after the card, so the foreign key resolves. One batch rather than a
    // statement each: a group photograph easily produces a dozen.
    //
    // Each is matched against the faces already NAMED on this board as it goes
    // in, so a photograph of somebody you have already identified arrives
    // already labelled — and the strings between the two cards appear with it,
    // because those are derived from a shared person rather than stored.
    const faces = spec.faces ?? []
    const matched = new Set<string>()
    if (faces.length > 0) {
        const known = await namedFaces(env, boardId)
        const insert = env.DB.prepare(
            'INSERT INTO faces (id, card_id, person_id, x, y, w, h, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )
        const rows = faces.map((f) => {
            const embedding = packEmbedding(f.embedding)
            const unpacked = unpackEmbedding(embedding)
            const match = unpacked ? matchFace(unpacked, known) : null
            if (match) matched.add(match.personId)
            return insert.bind(
                crypto.randomUUID(),
                id,
                match?.personId ?? null,
                f.x,
                f.y,
                f.w,
                f.h,
                embedding,
                now
            )
        })
        await env.DB.batch(rows)
    }

    // Only when something matched: naming the people found is worth a query,
    // reporting "0 recognised" is not.
    const recognised = matched.size > 0 ? await peopleNames(env, [...matched]) : []

    await notifyBoard(env, boardId)

    return {
        recognised,
        id,
        board_id: boardId,
        kind: spec.kind,
        x,
        y,
        rotation,
        scale,
        z,
        width: spec.width ?? null,
        height: spec.height ?? null,
        text,
        font_size: fontSize,
        color,
        r2_key: r2Key,
        grid_id: null,
        grid_column: null,
        grid_row: null,
        attached_to: null,
    }
}

/**
 * Duplicate a card.
 *
 * The copy POINTS AT THE SAME R2 objects rather than getting its own. Copying
 * the bytes would double the storage for every paste, and it is unnecessary:
 * the delete handler reclaims an object only once no card references it, which
 * it has to do anyway because a picture sticker can be stamped any number of
 * times from a single cut-out.
 *
 * Detected faces DO come along, because they are per-card: a duplicated
 * photograph that lost its faces would silently drop the strings it was part of.
 */
export async function duplicateCard(
    env: SkeinEnv,
    boardId: string,
    sourceId: string,
    at: { x?: number; y?: number }
): Promise<CardRow | null> {
    const row = await env.DB.prepare(
        `SELECT ${CARD_COLUMNS}, original_key, ocr_text FROM cards WHERE id = ? AND board_id = ?`
    )
        .bind(sourceId, boardId)
        .first<CardRow & { original_key: string | null; ocr_text: string | null }>()
    if (!row) return null

    // The card's SHAPE — how it is tilted, how big it is — is layout, and layout
    // is only in D1 as of the last flush. Copying a note that was resized two
    // seconds ago would otherwise reproduce the size it had before the resize.
    const live = await liveLayout(env, boardId)
    const source = { ...row, ...(live.get(sourceId) ?? {}) }

    const { results: sourceFaces } = await env.DB.prepare(
        'SELECT x, y, w, h FROM faces WHERE card_id = ?'
    )
        .bind(sourceId)
        .all<DetectedFace>()

    // Everything that makes the card LOOK the way it does comes across: how big
    // it is, how it is tilted, what colour it is and at what size it is set. A
    // paste that quietly reset the scale is not a copy, it is a new card that
    // happens to say the same thing.
    //
    // What deliberately does NOT come across is where it sits: the grid cell and
    // whatever it was stuck to belong to the original's place on the board, and
    // the copy is going somewhere else.
    return addCard(env, boardId, {
        kind: source.kind,
        text: source.text ?? undefined,
        r2Key: source.r2_key ?? undefined,
        originalKey: source.original_key ?? undefined,
        ocrText: source.ocr_text ?? undefined,
        faces: sourceFaces,
        width: source.width,
        height: source.height,
        rotation: source.rotation,
        scale: source.scale,
        color: source.color,
        fontSize: source.font_size,
        x: at.x,
        y: at.y,
    })
}

/** Resolve person ids to names, for telling somebody who was recognised. */
async function peopleNames(env: SkeinEnv, ids: string[]): Promise<string[]> {
    const placeholders = ids.map(() => '?').join(', ')
    const { results } = await env.DB.prepare(
        `SELECT name FROM people WHERE id IN (${placeholders}) ORDER BY name`
    )
        .bind(...ids)
        .all<{ name: string }>()
    return results.map((r) => r.name)
}

/**
 * Tell a board's Durable Object that D1 changed underneath it.
 *
 * The object holds live layout while a session is open and hydrates once, so
 * anything written directly to D1 is invisible to it until it is told.
 */
export async function notifyBoard(env: SkeinEnv, boardId: string): Promise<void> {
    const stub = env.BOARD.get(env.BOARD.idFromName(boardId))
    await stub.fetch('http://board/reload', { method: 'POST' })
}

/**
 * The board's live layout, if a session is open.
 *
 * D1 is the source of truth at rest and the Durable Object is the source of
 * truth while anyone is connected, because layout is flushed on a timer. A read
 * that consults only D1 can therefore be seconds out of date, and the symptom is
 * unmistakable: change a note's colour just after moving it and it jumps back to
 * where it was. The read path has to agree with the write path.
 */
export async function liveLayout(
    env: SkeinEnv,
    boardId: string
): Promise<Map<string, Partial<CardRow>>> {
    try {
        const stub = env.BOARD.get(env.BOARD.idFromName(boardId))
        const response = await stub.fetch('http://board/state')
        if (!response.ok) return new Map()
        const body = (await response.json()) as { cards?: Partial<CardRow>[] }
        return new Map((body.cards ?? []).map((row) => [String(row.id), row]))
    } catch (cause) {
        // Falling back to D1 is a stale board, not a broken one.
        console.warn(`[cards] live layout unavailable for ${boardId}:`, cause)
        return new Map()
    }
}
