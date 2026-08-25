// SPDX-License-Identifier: MIT OR Apache-2.0
// Copyright 2026 Ricardo Tejada - Tenologik Ltd. Co.

import { DurableObject } from 'cloudflare:workers'

export interface Env {
    BOARD: DurableObjectNamespace
    DB: D1Database
}

/**
 * Upper bound on how long an edit can sit here before it reaches D1.
 *
 * Dragging produces a burst of updates and every one of them would otherwise be
 * a database write, so they are coalesced. See `scheduleFlush` for why this is a
 * throttle rather than a debounce.
 */
const FLUSH_INTERVAL_MS = 3_000

/**
 * How many people may hold the pen at once.
 *
 * Viewers are not capped — they cost a socket and nothing else. Editors are,
 * because every editor is a writer to the same layout and the value of a shared
 * board falls off sharply once more than a handful of people are dragging the
 * same cards.
 */
const MAX_EDITORS = 8

/** Names are "Nimble Narwhal 4821" shaped. Long enough for one, short enough not to be a payload. */
const MAX_NAME_LENGTH = 40

interface Layout extends Record<string, SqlStorageValue> {
    id: string
    x: number
    y: number
    rotation: number
    scale: number
    z: number
    grid_id: string | null
    grid_column: string | null
    grid_row: string | null
    attached_to: string | null
}

interface CountRow extends Record<string, SqlStorageValue> {
    n: number
}

type MoveCommand = Partial<Layout> & { id: string }

interface Session {
    id: string
    socket: WebSocket
    role: 'view' | 'edit'
    name: string
    colour: string
    /**
     * The card this session is currently dragging, resizing or rotating.
     *
     * Held only so the room can put things right if they disappear mid-gesture:
     * everyone watching has been placing that card from this person's pointer,
     * and with the pointer gone there is nothing left to place it from.
     */
    gesture: { id: string } | null
    /** The card this session is typing into, held for the same reason as `gesture`. */
    typing: string | null
}

const PRESENCE_COLOURS = [
    '#ef4444',
    '#f97316',
    '#eab308',
    '#22c55e',
    '#06b6d4',
    '#6366f1',
    '#a855f7',
    '#ec4899',
]

/**
 * One board's live editing session.
 *
 * D1 is the source of truth at rest; this object is the source of truth while
 * anyone is connected. It hydrates from D1 on first use, serves every
 * subsequent read from its own SQLite, and flushes dirty rows back on an alarm.
 * That split is the reason a Durable Object is here at all: D1 has no way to
 * broadcast a change to other viewers, and no way to serialise two people
 * dragging the same card.
 *
 * What it is NOT is a general event log. It carries live layout and the two
 * things that only make sense while people are connected — who is here, and
 * what each of them is currently dragging. Undo is the client's, because undo
 * has to cover creating and deleting cards as well as moving them, and those
 * are D1's business rather than this object's.
 *
 * Sockets are accepted with the standard API rather than the hibernation one.
 * Hibernation would evict this object between messages and reset the in-memory
 * state that presence and in-flight gestures depend on — recoverable, but only
 * by serialising both onto every connection. At the scale a shared board
 * actually operates at, staying in memory is simpler and the difference in cost
 * is uninteresting.
 */
export class BoardRoom extends DurableObject<Env> {
    private sessions = new Map<WebSocket, Session>()

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS layout (
                id           TEXT PRIMARY KEY,
                x            REAL    NOT NULL DEFAULT 0,
                y            REAL    NOT NULL DEFAULT 0,
                rotation     REAL    NOT NULL DEFAULT 0,
                scale        REAL    NOT NULL DEFAULT 1,
                z            INTEGER NOT NULL DEFAULT 0,
                grid_id      TEXT,
                grid_column  TEXT,
                grid_row     TEXT,
                attached_to  TEXT,
                dirty        INTEGER NOT NULL DEFAULT 0
            )
        `)
    }

    // --- state ----------------------------------------------------------

    /**
     * Bring this object's layout into agreement with D1.
     *
     * Called once on first use, and again whenever a card is created or deleted
     * behind this object's back — those go straight to D1 over the REST API, so
     * without being told, the room would never learn a card exists.
     *
     * DIRTY ROWS ARE NOT OVERWRITTEN, and that is the whole subtlety. This object
     * is the newer copy of anything edited since the last flush, so refilling
     * wholesale from D1 threw away every unflushed position: drag a card, add a
     * note, and the drag was silently undone for everybody. What the refresh is
     * for is the SET of cards — which ones exist — not the layout of the ones
     * that were already here and have since moved.
     *
     * The board id is recovered from `ctx.id.name`, which exists only because
     * callers address this object with `idFromName(boardId)`. An object reached
     * by a raw id has no name, so it cannot hydrate and is left empty rather
     * than guessing.
     */
    private async hydrate(force = false): Promise<void> {
        const boardId = this.ctx.id.name
        if (!boardId) return

        if (!force) {
            const [existing] = this.ctx.storage.sql
                .exec<CountRow>('SELECT COUNT(*) AS n FROM layout')
                .toArray()
            if (existing && existing.n > 0) return
        }

        const { results } = await this.env.DB.prepare(
            `SELECT id, x, y, rotation, scale, z, grid_id, grid_column, grid_row, attached_to
               FROM cards WHERE board_id = ?`
        )
            .bind(boardId)
            .all<Layout>()

        // Cards that have gone from D1 have gone, dirty or not: there is no row
        // left for a flush to write back to.
        const live = new Set(results.map((row) => row.id))
        const held = this.ctx.storage.sql
            .exec<{ id: string } & Record<string, SqlStorageValue>>('SELECT id FROM layout')
            .toArray()
        for (const row of held) {
            if (!live.has(row.id)) {
                this.ctx.storage.sql.exec('DELETE FROM layout WHERE id = ?', row.id)
            }
        }

        for (const row of results) {
            this.ctx.storage.sql.exec(
                `INSERT INTO layout
                   (id, x, y, rotation, scale, z, grid_id, grid_column, grid_row, attached_to, dirty)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
                 ON CONFLICT(id) DO UPDATE SET
                    x = CASE WHEN layout.dirty = 1 THEN layout.x ELSE excluded.x END,
                    y = CASE WHEN layout.dirty = 1 THEN layout.y ELSE excluded.y END,
                    rotation = CASE WHEN layout.dirty = 1 THEN layout.rotation ELSE excluded.rotation END,
                    scale = CASE WHEN layout.dirty = 1 THEN layout.scale ELSE excluded.scale END,
                    z = CASE WHEN layout.dirty = 1 THEN layout.z ELSE excluded.z END,
                    grid_id = CASE WHEN layout.dirty = 1 THEN layout.grid_id ELSE excluded.grid_id END,
                    grid_column = CASE WHEN layout.dirty = 1 THEN layout.grid_column ELSE excluded.grid_column END,
                    grid_row = CASE WHEN layout.dirty = 1 THEN layout.grid_row ELSE excluded.grid_row END,
                    attached_to = CASE WHEN layout.dirty = 1 THEN layout.attached_to ELSE excluded.attached_to END`,
                row.id,
                row.x,
                row.y,
                row.rotation,
                row.scale,
                row.z,
                row.grid_id,
                row.grid_column,
                row.grid_row,
                row.attached_to
            )
        }
    }

    private snapshot(): Layout[] {
        return this.ctx.storage.sql
            .exec<Layout>(
                `SELECT id, x, y, rotation, scale, z, grid_id, grid_column, grid_row, attached_to
                   FROM layout ORDER BY z`
            )
            .toArray()
    }

    private read(id: string): Layout | undefined {
        return this.ctx.storage.sql
            .exec<Layout>(
                `SELECT id, x, y, rotation, scale, z, grid_id, grid_column, grid_row, attached_to
                   FROM layout WHERE id = ?`,
                id
            )
            .toArray()[0]
    }

    private write(next: Layout): void {
        this.ctx.storage.sql.exec(
            `INSERT INTO layout (id, x, y, rotation, scale, z, grid_id, grid_column, grid_row, attached_to, dirty)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
             ON CONFLICT(id) DO UPDATE SET
                x = excluded.x, y = excluded.y, rotation = excluded.rotation,
                scale = excluded.scale, z = excluded.z, grid_id = excluded.grid_id,
                grid_column = excluded.grid_column, grid_row = excluded.grid_row,
                attached_to = excluded.attached_to, dirty = 1`,
            next.id,
            next.x,
            next.y,
            next.rotation,
            next.scale,
            next.z,
            next.grid_id,
            next.grid_column,
            next.grid_row,
            next.attached_to
        )
    }

    // --- sockets --------------------------------------------------------

    private broadcast(payload: unknown, except?: WebSocket): void {
        const text = JSON.stringify(payload)
        for (const [socket] of this.sessions) {
            if (socket === except) continue
            try {
                socket.send(text)
            } catch {
                // A socket that has gone away is the close handler's problem.
            }
        }
    }

    private presence() {
        return [...this.sessions.values()].map((s) => ({
            id: s.id,
            name: s.name,
            colour: s.colour,
            role: s.role,
        }))
    }

    private editorCount(): number {
        return [...this.sessions.values()].filter((s) => s.role === 'edit').length
    }

    // --- editing --------------------------------------------------------

    /**
     * Apply a settled layout change and tell everyone else about it.
     *
     * Only ever called with a FINISHED position. What happens during a drag is
     * not sent here at all — see the `gesture` relay, which lets every other
     * client derive the card's position from the dragger's pointer rather than
     * being told it several times a second.
     *
     * There is no history here either. Undo belongs to the person doing the
     * undoing, it has to cover creating and deleting cards as well as moving
     * them, and both of those live in D1 rather than in this object. Keeping half
     * a history here would have meant Ctrl+Z stepping through a person's moves in
     * one order and their deletions in another.
     */
    private async applyMove(
        move: MoveCommand,
        actor?: Session,
        except?: WebSocket
    ): Promise<Layout | null> {
        const current = this.read(move.id)
        if (!current) return null

        const after: Layout = {
            ...current,
            ...Object.fromEntries(Object.entries(move).filter(([, v]) => v !== undefined)),
            id: current.id,
        } as Layout

        this.write(after)
        this.broadcast({ type: 'moved', card: after, actor: actor?.id ?? null }, except)
        await this.scheduleFlush()
        return after
    }

    // --- persistence ----------------------------------------------------

    /**
     * Schedule a write-behind flush, THROTTLED rather than debounced.
     *
     * A Durable Object has exactly one alarm, so `setAlarm` overwrites the
     * pending time rather than queueing another. Calling it on every edit
     * therefore pushes the flush further out with each change — and under
     * sustained editing it never fires at all, so an eviction loses everything
     * since the last quiet moment. That is precisely the window write-behind
     * exists to bound. Leaving an existing alarm alone gives a hard ceiling
     * instead, while a burst inside one window still collapses to one write.
     */
    private async scheduleFlush(): Promise<void> {
        if ((await this.ctx.storage.getAlarm()) === null) {
            await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS)
        }
    }

    async alarm(): Promise<void> {
        const dirty = this.ctx.storage.sql
            .exec<Layout>(
                `SELECT id, x, y, rotation, scale, z, grid_id, grid_column, grid_row, attached_to
                   FROM layout WHERE dirty = 1`
            )
            .toArray()
        if (dirty.length === 0) return

        const now = Date.now()
        const update = this.env.DB.prepare(
            `UPDATE cards SET x = ?, y = ?, rotation = ?, scale = ?, z = ?,
                    grid_id = ?, grid_column = ?, grid_row = ?, attached_to = ?, updated_at = ?
              WHERE id = ?`
        )
        try {
            await this.env.DB.batch(
                dirty.map((r) =>
                    update.bind(
                        r.x,
                        r.y,
                        r.rotation,
                        r.scale,
                        r.z,
                        r.grid_id,
                        r.grid_column,
                        r.grid_row,
                        r.attached_to,
                        now,
                        r.id
                    )
                )
            )
            this.ctx.storage.sql.exec('UPDATE layout SET dirty = 0 WHERE dirty = 1')
        } catch (error) {
            // Rows stay dirty so the next alarm retries rather than silently
            // dropping the edits.
            console.error('[board] flush to D1 failed, keeping rows dirty:', error)
            await this.ctx.storage.setAlarm(Date.now() + FLUSH_INTERVAL_MS)
        }
    }

    // --- entry points ---------------------------------------------------

    async fetch(request: Request): Promise<Response> {
        await this.hydrate()
        const url = new URL(request.url)

        if (url.pathname.endsWith('/state')) {
            return Response.json({
                board: this.ctx.id.name,
                cards: this.snapshot(),
                presence: this.presence(),
            })
        }

        // D1 changed underneath us — a card was created, deleted, renamed.
        if (request.method === 'POST' && url.pathname.endsWith('/reload')) {
            await this.hydrate(true)
            this.broadcast({ type: 'reload' })
            return Response.json({ ok: true, cards: this.snapshot().length })
        }

        // The board has been deleted. Let go of everything: there is no D1 row
        // left to hydrate from, so a layout kept here would be storage billed
        // against a board nobody can open, and a socket left attached would be
        // a session on a board that no longer exists.
        if (request.method === 'POST' && url.pathname.endsWith('/destroy')) {
            this.broadcast({ type: 'gone' })
            for (const [socket] of this.sessions) {
                try {
                    socket.close(1000, 'board deleted')
                } catch {
                    // Already gone; the close handler will tidy up.
                }
            }
            this.sessions.clear()
            this.ctx.storage.sql.exec('DELETE FROM layout')
            await this.ctx.storage.deleteAlarm()
            return Response.json({ ok: true })
        }

        // A content change that was written straight to D1; just relay it.
        if (request.method === 'POST' && url.pathname.endsWith('/relay')) {
            this.broadcast(await request.json())
            return Response.json({ ok: true })
        }

        if (request.method === 'POST' && url.pathname.endsWith('/move')) {
            const move = (await request.json()) as Partial<MoveCommand>
            if (!move?.id) return Response.json({ error: 'id is required' }, { status: 400 })
            const applied = await this.applyMove(move as MoveCommand)
            if (!applied) return Response.json({ error: 'no such card' }, { status: 404 })
            return Response.json({ ok: true })
        }

        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected a websocket upgrade', { status: 426 })
        }

        const requested = url.searchParams.get('role') === 'edit' ? 'edit' : 'view'
        const role: 'view' | 'edit' =
            requested === 'edit' && this.editorCount() >= MAX_EDITORS ? 'view' : requested

        const { 0: client, 1: server } = new WebSocketPair()
        server.accept()

        const session: Session = {
            id: crypto.randomUUID(),
            socket: server,
            role,
            name: url.searchParams.get('name')?.slice(0, MAX_NAME_LENGTH) || 'anonymous',
            colour: PRESENCE_COLOURS[this.sessions.size % PRESENCE_COLOURS.length]!,
            gesture: null,
            typing: null,
        }
        this.sessions.set(server, session)

        server.addEventListener('message', (event) => {
            void this.onMessage(session, event.data as string)
        })
        const drop = () => {
            this.sessions.delete(server)
            // Everyone watching has been placing this card from a pointer that
            // has just stopped existing. Say where it really is, or it stays
            // frozen at whatever the last frame happened to be.
            if (session.gesture) {
                const current = this.read(session.gesture.id)
                if (current) this.broadcast({ type: 'moved', card: current, actor: null })
                this.broadcast({ type: 'gesture', actor: session.id, gesture: null })
                session.gesture = null
            }
            // Same for a half-typed note: nobody else is going to finish it.
            if (session.typing) {
                this.broadcast({
                    type: 'typing',
                    id: session.typing,
                    text: null,
                    actor: session.id,
                })
                session.typing = null
            }
            this.broadcast({ type: 'presence', peers: this.presence() })
            // Their pointer goes with them; nothing else will ever report it.
            this.broadcast({ type: 'cursor', id: session.id, gone: true })
        }
        server.addEventListener('close', drop)
        server.addEventListener('error', drop)

        server.send(
            JSON.stringify({
                type: 'welcome',
                you: { id: session.id, name: session.name, colour: session.colour, role },
                // Said plainly rather than silently downgrading: asking to edit
                // and being handed a read-only board with no explanation is the
                // kind of thing people file bugs about.
                downgraded: requested === 'edit' && role === 'view',
                maxEditors: MAX_EDITORS,
                cards: this.snapshot(),
                presence: this.presence(),
            })
        )
        this.broadcast({ type: 'presence', peers: this.presence() }, server)

        return new Response(null, { status: 101, webSocket: client })
    }

    private async onMessage(session: Session, raw: string): Promise<void> {
        let message: { type?: string } & Record<string, unknown>
        try {
            message = JSON.parse(raw)
        } catch {
            session.socket.send(JSON.stringify({ type: 'error', error: 'malformed json' }))
            return
        }

        if (message.type === 'sync') {
            session.socket.send(
                JSON.stringify({
                    type: 'welcome',
                    cards: this.snapshot(),
                    presence: this.presence(),
                    you: {
                        id: session.id,
                        name: session.name,
                        colour: session.colour,
                        role: session.role,
                    },
                    maxEditors: MAX_EDITORS,
                })
            )
            return
        }

        // Cursors are the one thing viewers may send: watching where other
        // people are looking is most of the value of a shared board.
        if (message.type === 'cursor') {
            this.broadcast(
                {
                    type: 'cursor',
                    id: session.id,
                    colour: session.colour,
                    name: session.name,
                    x: message.x,
                    y: message.y,
                    // Said explicitly on the way out. Receivers do expire a
                    // cursor that stops reporting, but that leaves a pointer
                    // hanging over the board for seconds after someone's mouse
                    // has left it — long enough to look like a frozen tab.
                    gone: message.gone === true,
                },
                session.socket
            )
            return
        }

        if (session.role !== 'edit') {
            session.socket.send(
                JSON.stringify({ type: 'denied', reason: 'this link is view-only' })
            )
            return
        }

        // Keystrokes in a note, before they are a saved note.
        //
        // Relayed and never stored. An unfinished sentence is not a fact about
        // the board — it is a fact about a person, it stops being true the
        // moment they stop typing, and writing it down would mean deciding what
        // to do with the half-sentence somebody abandoned when their laptop
        // closed. The saved value arrives separately, through D1, the way every
        // other content change does.
        if (message.type === 'typing' && typeof message.id === 'string') {
            session.typing = typeof message.text === 'string' ? message.id : null
            this.broadcast(
                {
                    type: 'typing',
                    id: message.id,
                    text: typeof message.text === 'string' ? message.text.slice(0, 4000) : null,
                    actor: session.id,
                    name: session.name,
                    colour: session.colour,
                },
                session.socket
            )
            return
        }

        // A gesture that has begun or ended. Relayed and not stored: it says
        // how to interpret this person's pointer, and their pointer is already
        // on its way to everyone.
        if (message.type === 'gesture') {
            const gesture = message.gesture as { id?: string } | null
            session.gesture = gesture?.id ? { id: gesture.id } : null
            this.broadcast({ type: 'gesture', actor: session.id, gesture }, session.socket)
            return
        }

        if (message.type === 'move' && typeof message.id === 'string') {
            session.gesture = null
            await this.applyMove(message as unknown as MoveCommand, session, session.socket)
        }
    }
}

/**
 * Direct entry point. In production the web app reaches the object through a
 * cross-script Durable Object binding, but this makes the service independently
 * runnable with `wrangler dev`.
 */
export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url)
        const boardId = url.searchParams.get('board')
        if (!boardId) return new Response('missing ?board=<id>', { status: 400 })
        const stub = env.BOARD.get(env.BOARD.idFromName(boardId))
        return stub.fetch(request)
    },
} satisfies ExportedHandler<Env>
