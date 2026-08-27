import { defineStore } from 'pinia'

export interface Card {
    id: string
    kind: 'note' | 'image' | 'sticker'
    x: number
    y: number
    rotation: number
    scale: number
    z: number
    width: number | null
    height: number | null
    text: string | null
    font_size: number | null
    color: string | null
    r2_key: string | null
    grid_id: string | null
    grid_column: string | null
    grid_row: string | null
    attached_to: string | null
}

export interface Grid {
    id: string
    title: string | null
    x: number
    y: number
    width: number
    height: number
    columns: { id: string; label: string; color?: string }[]
    rows: { id: string; label: string }[]
}

export interface Face {
    id: string
    cardId: string
    personId: string | null
    x: number
    y: number
    w: number
    h: number
}

export interface Link {
    id: string
    fromCardId: string
    toCardId: string
    label: string | null
    color: string
    kind: 'manual' | 'person'
}

export interface Peer {
    id: string
    name: string
    colour: string
    role: 'view' | 'edit'
}

/** Somebody else's pointer, in board coordinates. */
export interface Cursor {
    id: string
    name: string
    colour: string
    x: number
    y: number
    /** When we last heard from it, so a tab that went away stops haunting the board. */
    at: number
}

/**
 * How often a pointer position goes out, and how long one survives silence.
 *
 * 40ms is 25 updates a second — under the threshold where a moving cursor stops
 * reading as continuous, and well under the rate a pointer actually fires at.
 * Every update is relayed to every other participant, so this is the one knob
 * that decides whether a busy board is chatty or a flood.
 */
const CURSOR_INTERVAL_MS = 40
const CURSOR_TIMEOUT_MS = 8_000

/**
 * How often keystrokes in a note go out to everyone else.
 *
 * Slower than the cursor on purpose. A pointer has to look continuous or it
 * looks broken; text does not — reading somebody type is legible in chunks, and
 * every update carries the whole note rather than a coordinate.
 */
const TYPING_INTERVAL_MS = 150

/**
 * How hard to try to get the socket back.
 *
 * A dropped socket used to be permanent: the board carried on working through
 * the REST fallback, so nothing looked broken, and the only symptom was that
 * other people's changes silently stopped arriving. Reconnecting matters more
 * here than in most apps for exactly that reason — the failure is invisible.
 *
 * Backoff rather than a fixed interval because the two causes look different: a
 * dev server restarting is back in a second, while a laptop that has closed its
 * lid should not spend the next hour retrying every second.
 */
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000]

/** How many steps back each person gets. Per session, never shared. */
const HISTORY_LIMIT = 50

/**
 * Matches MAX_NAME_LENGTH in services/board — long enough for "Whimsical
 * Wolverine 4821", short enough not to be a payload. Clamped here so the input
 * stops you rather than the object silently truncating what you typed.
 */
const MAX_NAME_LENGTH = 40

/** The layout fields a history entry has to restore. */
export type Layout = Pick<
    Card,
    'x' | 'y' | 'rotation' | 'scale' | 'z' | 'grid_id' | 'grid_column' | 'grid_row' | 'attached_to'
>

/** Everything needed to put a deleted card back, exactly as it was. */
export interface CardSnapshot {
    card: Record<string, unknown>
    faces: Record<string, unknown>[]
    links: Record<string, unknown>[]
}

/**
 * One step of history.
 *
 * `layout` covers a whole gesture at once — the card and any stickers that
 * travelled with it — because a drag is one thing that happened, not one thing
 * per card it touched.
 *
 * `existence` covers a card appearing or disappearing, in both directions.
 * Undoing a creation and redoing a deletion are the same operation, so they are
 * the same entry with the arrow pointing the other way; `snapshot` is refreshed
 * whenever the card is removed, which is the only moment its faces and strings
 * can still be read.
 */
type Entry =
    | { kind: 'layout'; items: { id: string; before: Layout; after: Layout }[] }
    | { kind: 'existence'; id: string; created: boolean; snapshot: CardSnapshot | null }
    | { kind: 'content'; id: string; before: Content; after: Content }

/** What a note SAYS and how it is set, as opposed to where it sits. */
type Content = Pick<Card, 'text' | 'color' | 'font_size'>

const CONTENT_KEYS = ['text', 'color', 'font_size'] as const
const contentOf = (card: Card): Content =>
    Object.fromEntries(CONTENT_KEYS.map((k) => [k, card[k]])) as Content
const sameContent = (a: Content, b: Content) => CONTENT_KEYS.every((k) => a[k] === b[k])

const LAYOUT_KEYS = [
    'x',
    'y',
    'rotation',
    'scale',
    'z',
    'grid_id',
    'grid_column',
    'grid_row',
    'attached_to',
] as const

const layoutOf = (card: Card): Layout =>
    Object.fromEntries(LAYOUT_KEYS.map((k) => [k, card[k]])) as Layout

/**
 * Layout equality for the purpose of HISTORY, which ignores stacking order.
 *
 * `z` changes every time a card is picked up, so counting it would put an undo
 * step on the stack for merely touching something — and Ctrl+Z would spend its
 * first few presses restoring stacking order nobody was thinking about. It is
 * still carried and still restored; it just does not, on its own, count as
 * having done anything.
 */
const sameLayout = (a: Layout, b: Layout) => LAYOUT_KEYS.every((k) => k === 'z' || a[k] === b[k])

export interface SearchHit {
    id: string
    kind: string
    excerpt: string
}

/**
 * What a click on the board means right now.
 *
 * Modal tools are a small state machine rather than a set of independent
 * booleans, because "stringing" and "stamping" are mutually exclusive and two
 * booleans can represent a state that has no meaning.
 */
export type Tool =
    { kind: 'select' } | { kind: 'string' } | { kind: 'stamp'; emoji?: string; r2Key?: string }

/** Which visual layer a card belongs to. Derived from kind so the two cannot disagree. */
export const layerOf = (kind: Card['kind']) => (kind === 'sticker' ? 2 : 1)

/** Fallback for legacy rows that stored a colour by name rather than as a hex value. */
const NAMED_COLOURS: Record<string, string> = {
    red: '#dc2626',
    amber: '#d97706',
    green: '#16a34a',
    blue: '#2563eb',
    violet: '#7c3aed',
    slate: '#475569',
}
export const stringColour = (value: string) =>
    NAMED_COLOURS[value] ?? (/^#[0-9a-f]{3,8}$/i.test(value) ? value : NAMED_COLOURS.red!)

/**
 * Everything on one board, and the socket that keeps it current.
 *
 * A STORE rather than a per-component composable, and the reason is a bug this
 * replaced. Board state is written from five places — the canvas, the toolbar,
 * the outline, the WebSocket and the REST layer — and when each of those held
 * its own view of it, a mutation that reloaded from the server would overwrite
 * positions the Durable Object had not flushed yet. Cards visibly jumped back.
 *
 * So there is exactly one copy of the state, and one rule about it: THE CLIENT
 * IS AUTHORITATIVE FOR WHAT THE USER JUST DID. A server response merges INTO
 * the existing objects (see `absorb`) instead of replacing them, which also
 * means a reload arriving mid-drag cannot pull the card out from under the
 * pointer.
 */
export const useBoardStore = defineStore('board', () => {
    const boardId = ref('')
    const title = ref('')
    const role = ref<'view' | 'edit'>('edit')
    const editable = computed(() => role.value === 'edit')

    const cards = ref<Card[]>([])
    const grids = ref<Grid[]>([])
    const faces = ref<Face[]>([])
    const links = ref<Link[]>([])
    const people = ref<Map<string, string>>(new Map())

    const peers = ref<Peer[]>([])
    const cursors = ref<Map<string, Cursor>>(new Map())
    /** What each other participant is currently dragging, keyed by their session id. */
    const gestures = ref<Map<string, Gesture>>(new Map())
    /** What somebody else is typing, keyed by CARD id — one editor per card. */
    const drafts = ref<Map<string, { text: string; name: string; colour: string; actor: string }>>(
        new Map()
    )
    const me = ref<Peer | null>(null)
    const connected = ref(false)
    /** Set when the board is deleted out from under us; the page leaves on it. */
    const deleted = ref(false)
    const notice = ref('')
    const error = ref('')
    const busy = ref(false)

    // --- ui state ---------------------------------------------------------
    const selectedId = ref<string | null>(null)
    const editingId = ref<string | null>(null)
    const tool = ref<Tool>({ kind: 'select' })
    const stringFrom = ref<string | null>(null)
    const inkColour = ref('#dc2626')
    const clipboard = ref<{ id: string; label: string } | null>(null)

    const undoStack = ref<Entry[]>([])
    const redoStack = ref<Entry[]>([])
    const canUndo = computed(() => undoStack.value.length > 0)
    const canRedo = computed(() => redoStack.value.length > 0)

    /** The gesture this client is performing, and where everything started. */
    let localGesture: { gesture: Gesture; before: Map<string, Layout> } | null = null

    const selected = computed(() => cards.value.find((c) => c.id === selectedId.value) ?? null)
    const selectedNote = computed(() => (selected.value?.kind === 'note' ? selected.value : null))

    let socket: WebSocket | null = null
    let cursorSentAt = 0
    let typingSentAt = 0
    let expiry: ReturnType<typeof setInterval> | null = null
    let retry: ReturnType<typeof setTimeout> | null = null
    let attempts = 0
    /** Set when we are deliberately leaving, so teardown is not read as a failure. */
    let closing = false

    // --- helpers ----------------------------------------------------------

    /**
     * Merge a fresh list into the live one, in place.
     *
     * Objects that already exist are updated rather than replaced, so component
     * identity, in-flight gestures and any local field the server does not know
     * about all survive a reload.
     */
    function absorb<T extends { id: string }>(current: Ref<T[]>, next: T[]): void {
        const byId = new Map(current.value.map((item) => [item.id, item]))
        current.value = next.map((item) => {
            const existing = byId.get(item.id)
            if (!existing) return item
            Object.assign(existing, item)
            return existing
        })
    }

    function fail(e: unknown): void {
        error.value =
            (e as { data?: { message?: string } })?.data?.message ??
            (e as Error)?.message ??
            'something went wrong'
    }

    /** Run a mutation, surfacing failure in one place instead of at every call site. */
    async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
        busy.value = true
        error.value = ''
        try {
            return await fn()
        } catch (e) {
            fail(e)
            return undefined
        } finally {
            busy.value = false
        }
    }

    // --- loading ----------------------------------------------------------

    async function load(): Promise<void> {
        const data = await api<{
            board: { title: string }
            cards: Card[]
            grids: Grid[]
            people: { id: string; name: string }[]
            faces: Face[]
            links: Link[]
        }>(`/api/boards/${boardId.value}`)

        title.value = data.board.title
        absorb(cards, data.cards)
        absorb(grids, data.grids)
        absorb(faces, data.faces)
        links.value = data.links
        people.value = new Map(data.people.map((p) => [p.id, p.name]))

        if (selectedId.value && !cards.value.some((c) => c.id === selectedId.value)) {
            selectedId.value = null
        }
    }

    function applyRemote(patch: Partial<Card> & { id: string }): void {
        const card = cards.value.find((c) => c.id === patch.id)
        if (card) Object.assign(card, patch)
    }

    // --- socket -----------------------------------------------------------

    async function connect(): Promise<void> {
        if (!import.meta.client || closing) return
        // The URL is resolved on every attempt, not cached. In development the
        // board worker's address changes whenever the dev server restarts, which
        // is the most common reason to be reconnecting in the first place.
        const { url } = await api<{ url: string | null }>(`/api/boards/${boardId.value}/socket`, {
            query: { role: role.value, name: displayName() },
        }).catch(() => ({ url: null }))
        if (!url) return scheduleReconnect()

        // A cursor is expired rather than only removed on notice: a browser that
        // is killed, suspended or loses its network never sends a goodbye, and a
        // pointer frozen on the board is read as someone standing still rather
        // than someone gone.
        expiry = setInterval(() => {
            const cutoff = Date.now() - CURSOR_TIMEOUT_MS
            for (const [id, cursor] of cursors.value) {
                if (cursor.at < cutoff) cursors.value.delete(id)
            }
        }, 2_000)

        socket = new WebSocket(url)
        socket.addEventListener('open', () => {
            connected.value = true
            attempts = 0
            // Everything that happened while we were away came from D1 or from
            // other people; catch up rather than assume nothing moved.
            void load().catch(fail)
        })
        socket.addEventListener('close', () => {
            connected.value = false
            me.value = null
            peers.value = []
            cursors.value = new Map()
            gestures.value = new Map()
            drafts.value = new Map()
            if (!deleted.value) scheduleReconnect()
        })
        socket.addEventListener('error', () => socket?.close())
        socket.addEventListener('message', async (event) => {
            const message = JSON.parse(event.data as string)
            switch (message.type) {
                case 'welcome':
                    me.value = message.you
                    peers.value = message.presence ?? []
                    if (message.downgraded) {
                        notice.value = `This board already has ${message.maxEditors} editors — you are viewing.`
                        role.value = 'view'
                    }
                    break
                case 'presence': {
                    peers.value = message.peers ?? []
                    // `me` is set from `welcome` and never again, so a rename
                    // would otherwise leave the toolbar showing the old name
                    // to the one person who changed it.
                    const mine = peers.value.find((p) => p.id === me.value?.id)
                    if (mine && me.value) me.value = { ...me.value, name: mine.name }
                    // Anyone no longer in the room cannot have a pointer in it.
                    const here = new Set(peers.value.map((p) => p.id))
                    for (const id of cursors.value.keys()) {
                        if (!here.has(id)) cursors.value.delete(id)
                    }
                    for (const id of gestures.value.keys()) {
                        if (!here.has(id)) gestures.value.delete(id)
                    }
                    for (const [cardId, draft] of drafts.value) {
                        if (!here.has(draft.actor)) drafts.value.delete(cardId)
                    }
                    break
                }
                case 'cursor':
                    if (message.gone) {
                        cursors.value.delete(message.id)
                        gestures.value.delete(message.id)
                        for (const [cardId, draft] of drafts.value) {
                            if (draft.actor === message.id) drafts.value.delete(cardId)
                        }
                    } else {
                        cursors.value.set(message.id, {
                            id: message.id,
                            name: message.name,
                            colour: message.colour,
                            x: message.x,
                            y: message.y,
                            at: Date.now(),
                        })
                        // A pointer is also a card position, when the person
                        // holding it is dragging something.
                        mirrorGesture(message.id, { x: message.x, y: message.y })
                    }
                    break
                case 'gesture':
                    if (message.gesture) gestures.value.set(message.actor, message.gesture)
                    else gestures.value.delete(message.actor)
                    break
                case 'typing':
                    if (typeof message.text === 'string') {
                        drafts.value.set(message.id, {
                            text: message.text,
                            name: message.name,
                            colour: message.colour,
                            actor: message.actor,
                        })
                    } else {
                        drafts.value.delete(message.id)
                    }
                    break
                case 'moved':
                    applyRemote({ ...message.card })
                    break
                case 'card:content':
                    applyRemote({
                        id: message.id,
                        ...(message.text !== undefined ? { text: message.text } : {}),
                        ...(message.font_size !== undefined
                            ? { font_size: message.font_size }
                            : {}),
                        ...(message.color !== undefined ? { color: message.color } : {}),
                    })
                    break
                case 'reload':
                    // The board may have gone in the moment between being told
                    // to reload and asking for it. Failing here would leave an
                    // unhandled rejection and no explanation on screen.
                    await load().catch(fail)
                    break
                case 'gone':
                    deleted.value = true
                    notice.value = 'This board was deleted.'
                    break
                case 'denied':
                    notice.value = message.reason
                    break
            }
        })
    }

    function scheduleReconnect(): void {
        if (closing || retry) return
        const delay = RECONNECT_DELAYS_MS[Math.min(attempts, RECONNECT_DELAYS_MS.length - 1)]!
        attempts += 1
        retry = setTimeout(() => {
            retry = null
            void connect()
        }, delay)
    }

    function send(payload: Record<string, unknown>): void {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
    }

    /**
     * Change your own display name.
     *
     * Sent over the socket rather than reconnecting with a new `?name=`, which
     * would drop the session and reappear to everyone else as somebody leaving
     * and a stranger arriving. The Durable Object trims and clamps it and
     * broadcasts presence to everyone including us, so the name that lands in
     * `me` is the one the room actually agreed on rather than the one typed.
     *
     * Persisted first, so it survives a reload even if the socket is down —
     * which is also the case where it takes effect on the next connect.
     */
    function renameSelf(name: string): boolean {
        const cleaned = name.trim().slice(0, MAX_NAME_LENGTH)
        if (!cleaned || cleaned === me.value?.name) return false
        if (import.meta.client) localStorage.setItem('skein:name', cleaned)
        send({ type: 'rename', name: cleaned })
        return true
    }

    /** Remembered per browser, so you are the same person when you come back. */
    function displayName(): string {
        if (!import.meta.client) return 'anonymous'
        const existing = localStorage.getItem('skein:name')
        if (existing) return existing
        const generated = generateDisplayName()
        localStorage.setItem('skein:name', generated)
        return generated
    }

    // --- layout -----------------------------------------------------------

    /**
     * Push a layout change.
     *
     * Over the socket when one is open, because a drag produces a stream of
     * these and a round trip through the REST API for each would be visible.
     * Falling back to the API keeps the board usable when the socket is not
     * available at all.
     */
    function move(card: Card, patch: Partial<Card> = {}): void {
        Object.assign(card, patch)
        const layout = {
            id: card.id,
            x: card.x,
            y: card.y,
            rotation: card.rotation,
            scale: card.scale,
            z: card.z,
            grid_id: card.grid_id,
            grid_column: card.grid_column,
            grid_row: card.grid_row,
            attached_to: card.attached_to,
        }
        if (socket?.readyState === WebSocket.OPEN) {
            send({ type: 'move', ...layout })
            return
        }
        void api(`/api/cards/${card.id}`, {
            method: 'PATCH',
            body: {
                x: card.x,
                y: card.y,
                rotation: card.rotation,
                scale: card.scale,
                z: card.z,
                gridId: card.grid_id,
                gridColumn: card.grid_column,
                gridRow: card.grid_row,
                attachedTo: card.attached_to,
            },
        }).catch(fail)
    }

    /** Bring a card to the front of its own layer, never past the layer above. */
    function bringToFront(card: Card): void {
        const sameLayer = cards.value.filter((c) => layerOf(c.kind) === layerOf(card.kind))
        const top = Math.max(0, ...sameLayer.map((c) => c.z))
        if (card.z !== top) move(card, { z: top + 1 })
    }

    /**
     * Change what a note SAYS, as opposed to where it sits.
     *
     * Applied locally first and never followed by a reload. Content lives in D1
     * and layout lives in the Durable Object, so re-reading the board to pick up
     * a colour change would also re-read a position that has not been flushed
     * yet — which is exactly how a note used to jump back to where it started.
     */
    function setContent(
        card: Card,
        patch: { text?: string; color?: string; fontSize?: number },
        options: { record?: boolean } = {}
    ): void {
        const before = contentOf(card)
        if (patch.text !== undefined) card.text = patch.text
        if (patch.color !== undefined) card.color = patch.color
        if (patch.fontSize !== undefined) card.font_size = patch.fontSize
        const after = contentOf(card)
        if (sameContent(before, after)) return

        // Recorded by default. Typing into a note and pressing Ctrl+Z should put
        // the old words back — not step over the edit and undo whatever you last
        // moved, which is what happens when only some actions are in the stack.
        if (options.record !== false) record({ kind: 'content', id: card.id, before, after })
        void api(`/api/cards/${card.id}`, { method: 'PATCH', body: patch }).catch(fail)
    }

    /** Put a whole content snapshot back, without recording the act of doing so. */
    function applyContent(card: Card, content: Content): void {
        setContent(
            card,
            {
                text: content.text ?? '',
                color: content.color ?? undefined,
                fontSize: content.font_size ?? undefined,
            },
            { record: false }
        )
    }

    /**
     * Publish where this person's pointer is, at most every `CURSOR_INTERVAL_MS`.
     *
     * Throttled here rather than at the call site so every caller gets it right
     * by default: the canvas calls this from `pointermove`, which fires as fast
     * as the display does.
     */
    function reportCursor(x: number, y: number): void {
        const now = Date.now()
        if (now - cursorSentAt < CURSOR_INTERVAL_MS) return
        cursorSentAt = now
        send({ type: 'cursor', x: Math.round(x), y: Math.round(y) })
    }

    /**
     * Publish what is being typed into a note, at most every
     * `TYPING_INTERVAL_MS`. Pass `null` when the editor closes.
     */
    function reportTyping(cardId: string, text: string | null): void {
        if (text === null) {
            typingSentAt = 0
            send({ type: 'typing', id: cardId, text: null })
            return
        }
        const now = Date.now()
        if (now - typingSentAt < TYPING_INTERVAL_MS) return
        typingSentAt = now
        send({ type: 'typing', id: cardId, text })
    }

    /** Tell the room the pointer has left, rather than letting it time out. */
    function hideCursor(): void {
        cursorSentAt = 0
        send({ type: 'cursor', gone: true })
    }

    // --- gestures ---------------------------------------------------------

    const followerIds = (gesture: Gesture) =>
        gesture.mode === 'move' ? gesture.followers.map((f) => f.id) : []

    /**
     * Announce a gesture, once, and remember where everything started.
     *
     * Nothing further goes out until it ends. Everyone else places the card from
     * this person's pointer, which they are already receiving — see
     * `app/utils/gesture.ts` for why that beats streaming positions.
     */
    function startGesture(gesture: Gesture): void {
        const before = new Map<string, Layout>()
        for (const id of [gesture.id, ...followerIds(gesture)]) {
            const card = cards.value.find((c) => c.id === id)
            if (card) before.set(id, layoutOf(card))
        }
        localGesture = { gesture, before }
        send({ type: 'gesture', gesture })
    }

    /**
     * Settle the gesture: persist what actually changed, and record ONE step.
     *
     * Comparing against the snapshot rather than persisting unconditionally is
     * what keeps a click from costing a round trip, and what keeps a gesture
     * that ended where it started out of the undo stack.
     */
    function endGesture(): void {
        const active = localGesture
        localGesture = null
        send({ type: 'gesture', gesture: null })
        if (!active) return

        const items: { id: string; before: Layout; after: Layout }[] = []
        for (const [id, before] of active.before) {
            const card = cards.value.find((c) => c.id === id)
            if (!card) continue
            const after = layoutOf(card)
            if (sameLayout(before, after)) continue
            items.push({ id, before, after })
            move(card)
        }
        if (items.length > 0) record({ kind: 'layout', items })
    }

    /**
     * Place a card from the pointer of whoever is dragging it.
     *
     * The mirror side of `startGesture`. Runs on every cursor update from
     * someone with a gesture in flight, and uses the same `gestureLayout` the
     * dragger is using, so the two cannot disagree about what a drag means.
     */
    function mirrorGesture(actor: string, at: { x: number; y: number }): void {
        const gesture = gestures.value.get(actor)
        if (!gesture) return
        const card = cards.value.find((c) => c.id === gesture.id)
        if (!card) return

        const next = gestureLayout(gesture, at)
        const dx = (next.x ?? card.x) - card.x
        const dy = (next.y ?? card.y) - card.y
        Object.assign(card, next)

        if (gesture.mode !== 'move') return
        for (const follower of gesture.followers) {
            const stuck = cards.value.find((c) => c.id === follower.id)
            if (stuck) {
                stuck.x += dx
                stuck.y += dy
            }
        }
    }

    /** Rename the board. Optimistic: the title is on screen while you type it. */
    async function rename(next: string): Promise<void> {
        const title_ = next.trim()
        if (!title_ || title_ === title.value) return
        const previous = title.value
        title.value = title_
        try {
            await api(`/api/boards/${boardId.value}`, { method: 'PATCH', body: { title: title_ } })
        } catch (e) {
            title.value = previous
            fail(e)
        }
    }

    // --- history ----------------------------------------------------------

    /**
     * Undo lives HERE, not in the Durable Object.
     *
     * It used to live there, where it could only ever cover moving things —
     * creating and deleting a card are D1's business, reached over the REST API,
     * and the object never hears about either. So Ctrl+Z stepped back through
     * your moves and silently ignored everything else you had done, which is
     * worse than not offering it.
     *
     * Here, every action passes through one place on its way out, so one stack
     * can hold all of them in the order they happened. It is per-person by
     * construction rather than by bookkeeping, and it survives a reconnect,
     * which the object's version did not.
     */
    function record(entry: Entry): void {
        undoStack.value.push(entry)
        if (undoStack.value.length > HISTORY_LIMIT) undoStack.value.shift()
        // A fresh action invalidates the redo branch, exactly as in an editor.
        redoStack.value.length = 0
    }

    /**
     * Step one entry back or forward.
     *
     * An entry is SKIPPED when the world no longer looks the way it left it —
     * someone else has moved the card since, or deleted it, or it is already
     * back. That is what "you cannot undo someone else's change" means in
     * practice: rather than clobbering their work, this declines and moves on to
     * your previous action.
     */
    async function step(direction: 'undo' | 'redo'): Promise<boolean> {
        const from = direction === 'undo' ? undoStack : redoStack
        const to = direction === 'undo' ? redoStack : undoStack

        while (from.value.length > 0) {
            const entry = from.value.pop()!
            const applied = await invert(entry, direction)
            if (!applied) continue
            to.value.push(applied)
            return true
        }
        return false
    }

    async function invert(entry: Entry, direction: 'undo' | 'redo'): Promise<Entry | null> {
        if (entry.kind === 'layout') {
            const moves: { card: Card; target: Layout }[] = []
            for (const item of entry.items) {
                const card = cards.value.find((c) => c.id === item.id)
                if (!card) continue
                const expected = direction === 'undo' ? item.after : item.before
                if (!sameLayout(layoutOf(card), expected)) return null
                moves.push({ card, target: direction === 'undo' ? item.before : item.after })
            }
            if (moves.length === 0) return null
            for (const { card, target } of moves) move(card, target)
            return entry
        }

        if (entry.kind === 'content') {
            const card = cards.value.find((c) => c.id === entry.id)
            if (!card) return null
            const expected = direction === 'undo' ? entry.after : entry.before
            if (!sameContent(contentOf(card), expected)) return null
            applyContent(card, direction === 'undo' ? entry.before : entry.after)
            return entry
        }

        // Undoing a creation and redoing a deletion are the same operation.
        const shouldExist = direction === 'undo' ? !entry.created : entry.created
        const present = cards.value.find((c) => c.id === entry.id)

        if (shouldExist) {
            if (present || !entry.snapshot) return null
            const ok = await restoreCard(entry.snapshot)
            return ok ? entry : null
        }
        if (!present) return null
        // Refreshed on the way out: this is the only moment the card's faces and
        // strings can still be read, and the other direction will need them.
        const snapshot = await deleteCard(present)
        return { ...entry, snapshot: snapshot ?? entry.snapshot }
    }

    const undo = () => step('undo')
    const redo = () => step('redo')

    // --- creation and removal --------------------------------------------

    /** Add a card the server just made to the local board, without a full reload. */
    function adopt(card: Card | undefined | null): Card | null {
        if (!card) return null
        const existing = cards.value.find((c) => c.id === card.id)
        if (existing) {
            Object.assign(existing, card)
            return existing
        }
        cards.value.push(card)
        return cards.value[cards.value.length - 1]!
    }

    async function addCard(spec: Record<string, unknown>): Promise<Card | null> {
        const result = await attempt(() =>
            api<{ card: Card; faces?: number }>(`/api/boards/${boardId.value}/cards`, {
                method: 'POST',
                body: spec,
            })
        )
        const card = adopt(result?.card)
        if (card) record({ kind: 'existence', id: card.id, created: true, snapshot: null })
        return card
    }

    /**
     * A new note is selected as soon as it exists.
     *
     * You just asked for it, so it is what you are about to work on — and the
     * note controls only appear for a selected note, so without this the colour
     * and text size of a brand new note were one unexplained click away.
     */
    async function addNote(at?: { x: number; y: number }): Promise<Card | null> {
        const card = await addCard({ kind: 'note', text: '', ...at })
        if (card) select(card.id)
        return card
    }

    const addSticker = (spec: { emoji?: string; r2Key?: string; x?: number; y?: number }) =>
        addCard({ kind: 'sticker', text: spec.emoji, r2Key: spec.r2Key, x: spec.x, y: spec.y })

    /** Remove a card and hand back what would be needed to put it back. */
    async function deleteCard(card: Card): Promise<CardSnapshot | null> {
        const index = cards.value.findIndex((c) => c.id === card.id)
        if (index === -1) return null
        // Detach anything pinned to it first, or the sticker outlives its host
        // and travels with nothing.
        for (const follower of cards.value.filter((c) => c.attached_to === card.id)) {
            follower.attached_to = null
        }
        cards.value.splice(index, 1)
        links.value = links.value.filter((l) => l.fromCardId !== card.id && l.toCardId !== card.id)
        if (selectedId.value === card.id) selectedId.value = null

        const result = await attempt(() =>
            api<{ snapshot: CardSnapshot }>(`/api/cards/${card.id}`, { method: 'DELETE' })
        )
        return result?.snapshot ?? null
    }

    /** Put a deleted card back, with its faces and whatever strings survived. */
    async function restoreCard(snapshot: CardSnapshot): Promise<boolean> {
        const result = await attempt(() =>
            api<{ restored: boolean }>('/api/cards/restore', { method: 'POST', body: snapshot })
        )
        if (!result) return false
        await load().catch(fail)
        return true
    }

    async function removeCard(card: Card): Promise<void> {
        const id = card.id
        const snapshot = await deleteCard(card)
        if (snapshot) record({ kind: 'existence', id, created: false, snapshot })
    }

    // --- clipboard --------------------------------------------------------

    function copy(card: Card): void {
        clipboard.value = {
            id: card.id,
            label: card.kind === 'note' ? (card.text || 'note').slice(0, 24) : card.kind,
        }
        notice.value = `Copied ${clipboard.value.label}`
    }

    async function cut(card: Card): Promise<void> {
        copy(card)
        await removeCard(card)
    }

    /**
     * Paste the clipboard entry at a point on the board.
     *
     * The SERVER duplicates the row, because a copy of an image is not a second
     * reference to the same R2 objects: deleting either card deletes those
     * objects, and the other card would be left pointing at nothing.
     */
    async function paste(at: { x: number; y: number }): Promise<Card | null> {
        const source = clipboard.value
        if (!source) return null
        const result = await attempt(() =>
            api<{ card: Card }>(`/api/boards/${boardId.value}/cards`, {
                method: 'POST',
                body: { copyOf: source.id, x: Math.round(at.x), y: Math.round(at.y) },
            })
        )
        const card = adopt(result?.card)
        if (card) {
            selectedId.value = card.id
            record({ kind: 'existence', id: card.id, created: true, snapshot: null })
        }
        return card
    }

    // --- tables -----------------------------------------------------------

    async function addGrid(preset: 'tier' | 'kanban' | 'plain', at?: { x: number; y: number }) {
        const result = await attempt(() =>
            api<{ grid: Grid }>(`/api/boards/${boardId.value}/grids`, {
                method: 'POST',
                body: { preset, title: preset, ...at },
            })
        )
        if (result?.grid) grids.value.push(result.grid)
        return result?.grid ?? null
    }

    function moveGrid(grid: Grid, patch: Partial<Grid>): void {
        Object.assign(grid, patch)
        void api(`/api/grids/${grid.id}`, {
            method: 'PATCH',
            body: { x: grid.x, y: grid.y },
        }).catch(fail)
    }

    async function removeGrid(grid: Grid): Promise<void> {
        grids.value = grids.value.filter((g) => g.id !== grid.id)
        for (const card of cards.value.filter((c) => c.grid_id === grid.id)) {
            card.grid_id = null
            card.grid_column = null
            card.grid_row = null
        }
        await attempt(() => api(`/api/grids/${grid.id}`, { method: 'DELETE' }))
    }

    // --- strings ----------------------------------------------------------

    async function link(fromCardId: string, toCardId: string): Promise<void> {
        const created = await attempt(() =>
            api<{ id: string; existed?: boolean }>(`/api/boards/${boardId.value}/links`, {
                method: 'POST',
                body: { fromCardId, toCardId, color: inkColour.value },
            })
        )
        if (!created || created.existed) return
        links.value.push({
            id: created.id,
            fromCardId,
            toCardId,
            label: null,
            color: inkColour.value,
            kind: 'manual',
        })
    }

    async function unlink(id: string): Promise<void> {
        links.value = links.value.filter((l) => l.id !== id)
        await attempt(() => api(`/api/links/${id}`, { method: 'DELETE' }))
    }

    // --- people -----------------------------------------------------------

    async function nameFace(face: Face, name: string): Promise<void> {
        const result = await attempt(() =>
            api<{ alsoNamed?: number }>(`/api/faces/${face.id}`, {
                method: 'PATCH',
                body: { name: name || null },
            })
        )
        // Naming a face can create a person, match that person in other
        // photographs, and therefore produce new derived strings — none of
        // which the client can work out on its own.
        await load()
        if (result?.alsoNamed) {
            notice.value = `Found ${name} in ${result.alsoNamed} other photograph(s).`
        }
    }

    // --- tools ------------------------------------------------------------

    function select(id: string | null): void {
        selectedId.value = id
        if (editingId.value && editingId.value !== id) editingId.value = null
    }

    function setTool(next: Tool): void {
        tool.value = next
        stringFrom.value = null
        if (next.kind !== 'select') select(null)
    }

    const resetTool = () => setTool({ kind: 'select' })

    // --- lifecycle --------------------------------------------------------

    /**
     * Point the store at a board.
     *
     * Guarded on the id having actually changed, and that guard is load-bearing:
     * the board is fetched during server rendering and arrives in the browser
     * inside the Nuxt payload, so an unconditional reset here would wipe the
     * state that was just handed to us and leave an empty board with nothing
     * scheduled to refill it.
     */
    function prepare(id: string, as: 'view' | 'edit'): void {
        if (boardId.value !== id) {
            deleted.value = false
            cards.value = []
            grids.value = []
            faces.value = []
            links.value = []
            people.value = new Map()
            selectedId.value = null
            editingId.value = null
            tool.value = { kind: 'select' }
        }
        boardId.value = id
        role.value = as
        closing = false
    }

    function close(): void {
        closing = true
        if (retry) clearTimeout(retry)
        retry = null
        attempts = 0
        if (socket?.readyState === WebSocket.OPEN) hideCursor()
        socket?.close()
        socket = null
        connected.value = false
        if (expiry) clearInterval(expiry)
        expiry = null
        cursors.value = new Map()
        gestures.value = new Map()
        drafts.value = new Map()
    }

    return {
        boardId,
        title,
        role,
        editable,
        cards,
        grids,
        faces,
        links,
        people,
        peers,
        cursors,
        me,
        connected,
        deleted,
        notice,
        error,
        busy,
        gestures,
        drafts,
        selectedId,
        selected,
        selectedNote,
        editingId,
        tool,
        stringFrom,
        inkColour,
        clipboard,
        prepare,
        connect,
        close,
        load,
        rename,
        renameSelf,
        MAX_NAME_LENGTH,
        move,
        startGesture,
        endGesture,
        reportCursor,
        hideCursor,
        reportTyping,
        bringToFront,
        setContent,
        undo,
        redo,
        canUndo,
        canRedo,
        addNote,
        addSticker,
        addCard,
        adopt,
        removeCard,
        copy,
        cut,
        paste,
        addGrid,
        moveGrid,
        removeGrid,
        link,
        unlink,
        nameFace,
        select,
        setTool,
        resetTool,
    }
})
