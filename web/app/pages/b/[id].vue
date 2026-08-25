<script setup lang="ts">
import type { Card, Grid } from '~/stores/board'

// Remount when the board id changes. Vue reuses a component across a param
// change by default, so without this, moving from one board to another would
// keep the first board's data and never re-run the fetch below.
definePageMeta({ key: (route) => String(route.params.id) })

const route = useRoute()
const boardId = computed(() => String(route.params.id))

// A share token decides what this visitor may do. Resolved before anything
// else, because it determines whether the socket asks for the pen.
const token = computed(() => (route.query.t ? String(route.query.t) : null))
const { data: share } = await useAsyncData(`skein:share:${token.value ?? 'none'}`, () =>
    token.value
        ? api<{ permission: 'view' | 'edit' }>(`/api/shares/${token.value}`).catch(() => null)
        : Promise.resolve(null)
)

const board = useBoardStore()
board.prepare(boardId.value, share.value?.permission ?? 'edit')

// Fetched during server rendering, so the board arrives already drawn. The
// socket is a client-only concern and is opened on mount.
await useAsyncData(`skein:board:${boardId.value}`, () => board.load().then(() => true))
onMounted(() => board.connect())
onBeforeUnmount(() => board.close())

// Deleted by somebody else while we had it open. Staying on a page whose board
// no longer exists just produces 404s on the next action.
watch(
    () => board.deleted,
    (gone) => gone && navigateTo('/boards')
)

// --- canvas --------------------------------------------------------------
const MIN_ZOOM = 0.15
const MAX_ZOOM = 2.5
/** Below this zoom, cards are inflated so they stay findable rather than dwindling to specks. */
const LEGIBILITY_FLOOR = 0.4

const view = ref({ x: 0, y: 0, scale: 1 })
const viewport = useTemplateRef<HTMLElement>('viewport')
const displayScale = (card: Card) => card.scale * Math.max(1, LEGIBILITY_FLOOR / view.value.scale)

function clampView() {
    const el = viewport.value
    if (!el) return
    const { scale } = view.value
    view.value.x = Math.min(0, Math.max(el.clientWidth - BOARD_WIDTH * scale, view.value.x))
    view.value.y = Math.min(0, Math.max(el.clientHeight - BOARD_HEIGHT * scale, view.value.y))
}

function zoomBy(factor: number, origin?: { x: number; y: number }) {
    const el = viewport.value
    if (!el) return
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.value.scale * factor))
    const focus = origin ?? { x: el.clientWidth / 2, y: el.clientHeight / 2 }
    // Keep the point under the cursor still while the scale changes.
    view.value.x = focus.x - ((focus.x - view.value.x) * next) / view.value.scale
    view.value.y = focus.y - ((focus.y - view.value.y) * next) / view.value.scale
    view.value.scale = next
    clampView()
}

/** Where a client-space point lands on the board. */
function toBoard(clientX: number, clientY: number) {
    const el = viewport.value
    if (!el) return { x: 0, y: 0 }
    const rect = el.getBoundingClientRect()
    return {
        x: (clientX - rect.left - view.value.x) / view.value.scale,
        y: (clientY - rect.top - view.value.y) / view.value.scale,
    }
}

/** The middle of what the user is currently looking at, in board coordinates. */
function viewportCentre() {
    const el = viewport.value
    if (!el) return { x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 }
    return toBoard(
        el.getBoundingClientRect().left + el.clientWidth / 2,
        el.getBoundingClientRect().top + el.clientHeight / 2
    )
}

// --- geometry ------------------------------------------------------------
// Measured sizes are UNSCALED, because a card is scaled about its centre: its
// centre is `x + width / 2` whatever the scale is, and only the extent changes.
// Storing the scaled size instead made the centre move every time a card was
// resized, which dragged every string attached to it.
const sizes = ref<Record<string, { w: number; h: number }>>({})

const centres = computed(() => {
    const out: Record<string, { x: number; y: number }> = {}
    for (const card of board.cards) {
        const size = sizes.value[card.id]
        if (!size) continue
        out[card.id] = { x: card.x + size.w / 2, y: card.y + size.h / 2 }
    }
    return out
})

/** A card's box on the board, ignoring rotation — good enough to snap and clamp with. */
function boxOf(card: Card) {
    const size = sizes.value[card.id] ?? { w: 176, h: 96 }
    const scale = displayScale(card)
    const cx = card.x + size.w / 2
    const cy = card.y + size.h / 2
    const halfW = (size.w * scale) / 2
    const halfH = (size.h * scale) / 2
    return { cx, cy, halfW, halfH, left: cx - halfW, top: cy - halfH, w: size.w, h: size.h }
}

function measure() {
    const el = viewport.value
    if (!el) return
    const next: Record<string, { w: number; h: number }> = {}
    for (const card of board.cards) {
        const node = el.querySelector<HTMLElement>(`[data-card-id="${card.id}"]`)
        if (node) next[card.id] = { w: node.offsetWidth, h: node.offsetHeight }
    }
    sizes.value = next
}
/**
 * Re-measure whenever a card's box actually changes, rather than guessing when.
 *
 * Measuring on `nextTick` after the list changed was measuring a photograph
 * BEFORE its image had loaded, when the card is a few pixels wide — and every
 * consumer of that number was quietly wrong: face boxes came out a fiftieth of
 * their real size in the corner of the picture, and strings attached to a
 * photograph's corner instead of its middle. A ResizeObserver notices the image
 * arriving, a note reflowing as it is typed into, and a font finishing loading,
 * none of which are worth trying to enumerate.
 *
 * There is no feedback loop here: nothing `sizes` feeds is part of a card's own
 * layout. Face boxes are absolutely positioned inside the card, and strings are
 * drawn on a separate layer.
 */
let sizeWatcher: ResizeObserver | null = null

function observeCards() {
    const el = viewport.value
    if (!el || !sizeWatcher) return
    sizeWatcher.disconnect()
    for (const node of el.querySelectorAll('[data-card-id]')) sizeWatcher.observe(node)
}

watch(
    () => board.cards.length,
    () => nextTick(observeCards),
    { immediate: true }
)

/** Frame everything on the board, so nothing is ever truly lost. */
function fitToContents() {
    const el = viewport.value
    if (!el) return
    const boxes = [
        ...board.cards.map((c) => {
            const b = boxOf(c)
            return { x: b.left, y: b.top, w: b.halfW * 2, h: b.halfH * 2 }
        }),
        ...board.grids.map((g) => ({ x: g.x, y: g.y, w: g.width, h: g.height })),
    ]
    if (boxes.length === 0) {
        view.value = { x: 0, y: 0, scale: 1 }
        return
    }
    const minX = Math.min(...boxes.map((b) => b.x)) - 80
    const minY = Math.min(...boxes.map((b) => b.y)) - 80
    const maxX = Math.max(...boxes.map((b) => b.x + b.w)) + 80
    const maxY = Math.max(...boxes.map((b) => b.y + b.h)) + 80
    const scale = Math.min(
        MAX_ZOOM,
        Math.max(
            MIN_ZOOM,
            Math.min(el.clientWidth / (maxX - minX), el.clientHeight / (maxY - minY))
        )
    )
    view.value = { scale, x: -minX * scale, y: -minY * scale }
    clampView()
}

onMounted(() => {
    sizeWatcher = new ResizeObserver(() => measure())
    nextTick(() => {
        observeCards()
        measure()
        fitToContents()
    })
    window.addEventListener('resize', clampView)
    window.addEventListener('keydown', onKeyDown)
})
onBeforeUnmount(() => {
    sizeWatcher?.disconnect()
    sizeWatcher = null
    window.removeEventListener('resize', clampView)
    window.removeEventListener('keydown', onKeyDown)
})

// --- pointer -------------------------------------------------------------
const panning = ref<{ x: number; y: number; ox: number; oy: number } | null>(null)
/** Last position of the pointer on the board — where a paste or a stamp lands. */
const pointerAt = ref({ x: BOARD_WIDTH / 2, y: BOARD_HEIGHT / 2 })
/** Screen position of the pointer, for the sticker that follows it. */
const ghostAt = ref({ x: 0, y: 0 })

function onWheel(event: WheelEvent) {
    const el = viewport.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    zoomBy(event.deltaY < 0 ? 1.12 : 1 / 1.12, {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
    })
}

/**
 * A press on empty board.
 *
 * What that means depends on the tool: it puts a sticker down, cancels
 * stringing, or starts a pan. In every case it also clears the selection —
 * "click away to deselect" is how every canvas works, and without it the note
 * controls stayed on screen pointing at something the user had stopped
 * thinking about.
 */
function onBackgroundDown(event: PointerEvent) {
    if (board.tool.kind === 'stamp') {
        void stampHere(toBoard(event.clientX, event.clientY))
        return
    }
    if (board.tool.kind === 'string') board.resetTool()
    board.select(null)
    panning.value = { x: event.clientX, y: event.clientY, ox: view.value.x, oy: view.value.y }
}

// --- dragging ------------------------------------------------------------
// Capture is taken only once the pointer has MOVED past a threshold, never on
// pointerdown: setPointerCapture retargets subsequent click events, which
// swallows the double-click that opens a note for editing.
const DRAG_THRESHOLD_PX = 4

/**
 * A gesture in progress on THIS machine.
 *
 * The shared part — the bit other people need to follow along — is the
 * `Gesture` from `~/utils/gesture`, and it is the same object they receive.
 * Everything alongside it here is local: where the press landed, so the drag
 * threshold can be measured, and the card objects themselves, which nobody
 * else's copy of this board would recognise.
 */
type Active =
    | { kind: 'card'; gesture: Gesture; card: Card; sx: number; sy: number; live: boolean }
    | { kind: 'grid'; grid: Grid; sx: number; sy: number; ox: number; oy: number }
const gesture = ref<Active | null>(null)

const followersOf = (card: Card) =>
    board.cards
        .filter((c) => c.attached_to === card.id)
        .map((c) => ({ id: c.id, ox: c.x - card.x, oy: c.y - card.y }))

function begin(card: Card, event: PointerEvent, shared: Gesture) {
    // Announced BEFORE anything is changed, so the snapshot the store keeps for
    // undo is the state the card was actually in when it was picked up.
    board.startGesture(shared)
    board.bringToFront(card)
    gesture.value = {
        kind: 'card',
        gesture: shared,
        card,
        sx: event.clientX,
        sy: event.clientY,
        live: shared.mode !== 'move',
    }
}

function grabCard(event: PointerEvent, card: Card) {
    if (board.tool.kind === 'stamp') {
        void stampHere(toBoard(event.clientX, event.clientY), card)
        return
    }
    if (!board.editable) return board.select(card.id)
    if (board.tool.kind === 'string') return pickForString(card)
    if (board.editingId === card.id) return
    board.select(card.id)

    const at = toBoard(event.clientX, event.clientY)
    begin(card, event, {
        mode: 'move',
        id: card.id,
        // Where in the card the pointer took hold, so it stays under that spot.
        dx: at.x - card.x,
        dy: at.y - card.y,
        // A sticker stuck to this card is part of it now — dragging the
        // photograph has to take the sticker with it, or `attached_to` is a
        // fact the board records and then ignores.
        followers: followersOf(card),
    })
}

function startRotate(event: PointerEvent, card: Card) {
    const box = boxOf(card)
    const at = toBoard(event.clientX, event.clientY)
    begin(card, event, {
        mode: 'rotate',
        id: card.id,
        cx: box.cx,
        cy: box.cy,
        start: angleOf({ x: box.cx, y: box.cy }, at),
        base: card.rotation,
    })
}

function startResize(event: PointerEvent, card: Card) {
    const box = boxOf(card)
    const at = toBoard(event.clientX, event.clientY)
    begin(card, event, {
        mode: 'resize',
        id: card.id,
        cx: box.cx,
        cy: box.cy,
        reach: Math.max(8, Math.hypot(at.x - box.cx, at.y - box.cy)),
        base: card.scale,
    })
}

/** Keep a card's visible box on the board, however it has been scaled. */
function clampCard(card: Card, x: number, y: number) {
    const box = boxOf(card)
    const minX = box.halfW - box.w / 2
    const minY = box.halfH - box.h / 2
    return {
        x: Math.min(BOARD_WIDTH - box.halfW - box.w / 2, Math.max(minX, x)),
        y: Math.min(BOARD_HEIGHT - box.halfH - box.h / 2, Math.max(minY, y)),
    }
}

function onPointerMove(event: PointerEvent) {
    ghostAt.value = { x: event.clientX, y: event.clientY }
    pointerAt.value = toBoard(event.clientX, event.clientY)
    // Sent on every pointer move and throttled inside the store, so panning and
    // dragging publish a pointer too — those are exactly the moments when
    // watching someone else work tells you the most.
    board.reportCursor(pointerAt.value.x, pointerAt.value.y)

    if (panning.value) {
        view.value.x = panning.value.ox + (event.clientX - panning.value.x)
        view.value.y = panning.value.oy + (event.clientY - panning.value.y)
        clampView()
        return
    }
    const g = gesture.value
    if (!g) return

    if (g.kind === 'grid') {
        g.grid.x = Math.max(0, Math.round(g.ox + (event.clientX - g.sx) / view.value.scale))
        g.grid.y = Math.max(0, Math.round(g.oy + (event.clientY - g.sy) / view.value.scale))
        return
    }

    // The threshold exists so a double-click is not read as a one-pixel drag.
    if (
        !g.live &&
        Math.abs(event.clientX - g.sx) < DRAG_THRESHOLD_PX &&
        Math.abs(event.clientY - g.sy) < DRAG_THRESHOLD_PX
    )
        return
    g.live = true

    // The SAME function everyone watching is about to run against the same
    // pointer. Nothing about the result is computed twice in two places.
    const next = gestureLayout(g.gesture, pointerAt.value, { snap: event.shiftKey })
    if (g.gesture.mode === 'move') {
        const clamped = clampCard(g.card, next.x!, next.y!)
        const dx = clamped.x - g.card.x
        const dy = clamped.y - g.card.y
        g.card.x = clamped.x
        g.card.y = clamped.y
        for (const follower of g.gesture.followers) {
            const stuck = board.cards.find((c) => c.id === follower.id)
            if (stuck) {
                stuck.x += dx
                stuck.y += dy
            }
        }
    } else {
        Object.assign(g.card, next)
    }
}

function onPointerUp() {
    panning.value = null
    const g = gesture.value
    gesture.value = null
    if (!g) return

    if (g.kind === 'grid') {
        board.moveGrid(g.grid, { x: g.grid.x, y: g.grid.y })
        return
    }
    // Where it landed decides what it landed ON, and that has to be settled
    // before the gesture is closed — the settled move carries it.
    if (g.gesture.mode === 'move' && g.live) snap(g.card)
    // Persists whatever actually changed and records one step. A click that
    // never moved changes nothing, so it costs nothing.
    board.endGesture()
}

/**
 * Decide what a card landed on.
 *
 * Stickers prefer cards, then tables — a sticker dropped on a photo should
 * travel with the photo, not with the table underneath it. Notes and images
 * only ever snap into table cells.
 */
function snap(card: Card) {
    const box = boxOf(card)
    const centre = { x: box.cx, y: box.cy }

    if (card.kind === 'sticker') {
        card.attached_to = hostAt(centre, card.id)?.id ?? null
        if (card.attached_to) return
    }

    const grid = board.grids.find(
        (g) =>
            centre.x >= g.x &&
            centre.y >= g.y &&
            centre.x <= g.x + g.width &&
            centre.y <= g.y + g.height
    )
    if (!grid) {
        card.grid_id = null
        card.grid_column = null
        card.grid_row = null
        return
    }
    const labelWidth = grid.rows.some((r) => r.label) ? 64 : 0
    const headerHeight = grid.columns.some((c) => c.label) ? 26 : 0
    const cellW = (grid.width - labelWidth) / grid.columns.length
    const cellH = (grid.height - 32 - headerHeight) / grid.rows.length
    const col = Math.min(
        grid.columns.length - 1,
        Math.max(0, Math.floor((centre.x - grid.x - labelWidth) / cellW))
    )
    const row = Math.min(
        grid.rows.length - 1,
        Math.max(0, Math.floor((centre.y - grid.y - 32 - headerHeight) / cellH))
    )
    card.grid_id = grid.id
    card.grid_column = grid.columns[col]?.id ?? null
    card.grid_row = grid.rows[row]?.id ?? null
}

/** The topmost non-sticker card under a board point. */
function hostAt(point: { x: number; y: number }, exclude?: string) {
    return board.cards
        .filter((c) => c.id !== exclude && c.kind !== 'sticker')
        .filter((c) => {
            const b = boxOf(c)
            return (
                point.x >= b.left &&
                point.y >= b.top &&
                point.x <= b.left + b.halfW * 2 &&
                point.y <= b.top + b.halfH * 2
            )
        })
        .sort((a, b) => a.z - b.z)
        .pop()
}

// --- faces ---------------------------------------------------------------
/** Which face box is currently asking who it is. */
const namingFaceId = ref<string | null>(null)

// --- tools ---------------------------------------------------------------
const pings = ref<{ id: number; x: number; y: number }[]>([])
let pingId = 0

/** Visible confirmation that a stamp landed, which a static sticker does not give. */
function ping(x: number, y: number) {
    const id = ++pingId
    pings.value.push({ id, x, y })
    setTimeout(() => (pings.value = pings.value.filter((p) => p.id !== id)), 500)
}

async function stampHere(point: { x: number; y: number }, onto?: Card) {
    const tool = board.tool
    if (tool.kind !== 'stamp' || !board.editable) return
    ping(point.x, point.y)
    const card = await board.addSticker({
        emoji: tool.emoji,
        r2Key: tool.r2Key,
        // Stamped from the middle: the pointer is where the sticker should
        // appear to land, not where its top-left corner goes.
        x: Math.round(point.x - 24),
        y: Math.round(point.y - 24),
    })
    if (!card) return
    const host = onto ?? hostAt(point, card.id)
    if (host) board.move(card, { attached_to: host.id })
}

function pickForString(card: Card) {
    if (!board.stringFrom) {
        board.stringFrom = card.id
        return
    }
    if (board.stringFrom === card.id) {
        board.stringFrom = null
        return
    }
    const from = board.stringFrom
    board.stringFrom = null
    board.resetTool()
    void board.link(from, card.id)
}

// --- keyboard ------------------------------------------------------------
function typing(target: EventTarget | null) {
    const el = target as HTMLElement | null
    return (
        !!el &&
        (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable === true)
    )
}

function onKeyDown(event: KeyboardEvent) {
    // A focused field owns every key it receives, INCLUDING Escape. Handling
    // Escape here as well meant closing a note's editor and clearing the
    // selection in one press: the editor's own handler ran first, so by the time
    // this saw the key there was no longer an editor open to explain it.
    if (typing(event.target)) return

    if (event.key === 'Escape') {
        if (board.tool.kind !== 'select') board.resetTool()
        else board.select(null)
        return
    }

    const accel = event.ctrlKey || event.metaKey
    const card = board.selected

    if (accel && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) board.redo()
        else board.undo()
        return
    }
    if (!board.editable) return

    if (accel && event.key.toLowerCase() === 'c' && card) {
        event.preventDefault()
        board.copy(card)
    } else if (accel && event.key.toLowerCase() === 'x' && card) {
        event.preventDefault()
        void board.cut(card)
    } else if (accel && event.key.toLowerCase() === 'v' && board.clipboard) {
        event.preventDefault()
        void board.paste(pointerAt.value)
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && card) {
        event.preventDefault()
        void board.removeCard(card)
    }
}

// --- search --------------------------------------------------------------
const searchTerm = ref('')
const results = ref<{ id: string; kind: string; excerpt: string }[]>([])
const searching = ref(false)
const highlighted = ref<string | null>(null)

async function runSearch(term: string) {
    const q = term.trim()
    if (!q) {
        results.value = []
        return
    }
    searching.value = true
    try {
        const found = await api<{ results: typeof results.value }>(
            `/api/boards/${boardId.value}/search`,
            { query: { q } }
        )
        results.value = found.results
    } finally {
        searching.value = false
    }
}

/** Centre the view on something and flash it, so a result is findable on a big board. */
function reveal(x: number, y: number, id?: string) {
    const el = viewport.value
    if (!el) return
    view.value.x = el.clientWidth / 2 - x * view.value.scale
    view.value.y = el.clientHeight / 2 - y * view.value.scale
    clampView()
    if (!id) return
    board.select(id)
    highlighted.value = id
    setTimeout(() => highlighted.value === id && (highlighted.value = null), 2000)
}

function revealCard(id: string) {
    const card = board.cards.find((c) => c.id === id)
    if (!card) return
    const box = boxOf(card)
    reveal(box.cx, box.cy, id)
}

function revealGrid(id: string) {
    const grid = board.grids.find((g) => g.id === id)
    if (grid) reveal(grid.x + grid.width / 2, grid.y + grid.height / 2)
}

// --- chrome --------------------------------------------------------------
const shareOpen = ref(false)
const systemOpen = ref(false)
const outlineOpen = ref(false)
const media = ref<{ open: boolean; mode: 'image' | 'sticker' }>({ open: false, mode: 'image' })

function openMedia(mode: 'image' | 'sticker') {
    media.value = { open: true, mode }
}

function mediaAdded(card: Card, recognised: string[]) {
    board.adopt(card)
    board.select(card.id)
    if (card.kind === 'sticker') board.setTool({ kind: 'stamp', r2Key: card.r2_key ?? undefined })
    // Worth saying out loud. The face boxes appear either way, but "we already
    // know who this is" is the interesting part and it is easy to miss on a
    // photograph you have only just added.
    if (recognised.length > 0) {
        board.notice = `Recognised ${recognised.join(', ')} in this photograph.`
        void board.load()
    }
}

const NOTE_COLOURS = ['#fde68a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#e9d5ff', '#fed7aa']
const stamping = computed(() => (board.tool.kind === 'stamp' ? board.tool : null))
</script>

<template>
    <div class="flex h-screen flex-col bg-elevated">
        <BoardToolbar
            v-model:term="searchTerm"
            :searching="searching"
            :outline-open="outlineOpen"
            @add-note="board.addNote(viewportCentre())"
            @add-image="openMedia('image')"
            @import-sticker="openMedia('sticker')"
            @add-table="(preset) => board.addGrid(preset, viewportCentre())"
            @search="runSearch"
            @toggle-outline="outlineOpen = !outlineOpen"
            @share="shareOpen = true"
            @system="systemOpen = true"
        />

        <div class="relative flex flex-1 overflow-hidden">
            <!-- The viewport. Panning and zooming happen here; the board itself
                 is a single transformed layer, so nothing inside needs to know
                 the view exists. -->
            <div
                ref="viewport"
                class="relative flex-1 overflow-hidden"
                :class="
                    stamping
                        ? 'cursor-none'
                        : board.tool.kind === 'string'
                          ? 'cursor-crosshair'
                          : 'cursor-grab active:cursor-grabbing'
                "
                @pointerdown.self="onBackgroundDown"
                @pointermove="onPointerMove"
                @pointerup="onPointerUp"
                @pointerleave="(onPointerUp(), board.hideCursor())"
                @wheel.prevent="onWheel"
            >
                <div
                    class="absolute origin-top-left bg-[radial-gradient(circle,var(--ui-border)_1px,transparent_1px)] [background-size:24px_24px]"
                    :style="{
                        width: `${BOARD_WIDTH}px`,
                        height: `${BOARD_HEIGHT}px`,
                        transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                    }"
                    @pointerdown.self="onBackgroundDown"
                >
                    <StringLayer
                        :links="board.links"
                        :centres="centres"
                        :view-scale="view.scale"
                        @cut="board.unlink"
                    />

                    <BoardCursors :view-scale="view.scale" />

                    <BoardGrid
                        v-for="grid in board.grids"
                        :key="grid.id"
                        :grid="grid"
                        :editable="board.editable"
                        @grab="
                            (e) =>
                                board.editable &&
                                (gesture = {
                                    kind: 'grid',
                                    grid,
                                    sx: e.clientX,
                                    sy: e.clientY,
                                    ox: grid.x,
                                    oy: grid.y,
                                })
                        "
                        @remove="board.removeGrid(grid)"
                    />

                    <BoardCard
                        v-for="card in board.cards"
                        :key="card.id"
                        :card="card"
                        :faces="board.faces.filter((f) => f.cardId === card.id)"
                        :people="board.people"
                        :editable="board.editable"
                        :editing="board.editingId === card.id"
                        :selected="board.selectedId === card.id"
                        :naming="namingFaceId"
                        :string-mode="board.tool.kind === 'string'"
                        :string-source="board.stringFrom === card.id"
                        :highlighted="highlighted === card.id"
                        :rendered-width="sizes[card.id]?.w ?? 240"
                        :display-scale="displayScale(card)"
                        :view-scale="view.scale"
                        :remote-draft="board.drafts.get(card.id) ?? null"
                        @typing="(t: string) => board.reportTyping(card.id, t)"
                        @grab="(e) => grabCard(e, card)"
                        @resize="(e) => startResize(e, card)"
                        @rotate="(e) => startRotate(e, card)"
                        @edit="board.editingId = card.id"
                        @save-text="
                            (t) => (
                                (board.editingId = null),
                                board.reportTyping(card.id, null),
                                board.setContent(card, { text: t })
                            )
                        "
                        @remove="board.removeCard(card)"
                        @name-face="(f) => (namingFaceId = f.id)"
                        @save-name="(f, n) => ((namingFaceId = null), board.nameFace(f, n))"
                        @cancel-name="namingFaceId = null"
                    />

                    <!-- Where a stamp just landed. -->
                    <span
                        v-for="p in pings"
                        :key="p.id"
                        class="pointer-events-none absolute z-[3000] animate-ping rounded-full border-2 border-primary"
                        :style="{
                            left: `${p.x - 20}px`,
                            top: `${p.y - 20}px`,
                            width: '40px',
                            height: '40px',
                        }"
                    />
                </div>

                <!-- The sticker rides the pointer. A custom CSS cursor is capped
                     at 128px and cannot carry an arbitrary image, so this is a
                     real element positioned on the screen instead. -->
                <span
                    v-if="stamping"
                    class="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-1/2 drop-shadow"
                    :style="{ left: `${ghostAt.x}px`, top: `${ghostAt.y}px` }"
                >
                    <span v-if="stamping.emoji" class="block text-4xl leading-none">{{
                        stamping.emoji
                    }}</span>
                    <img
                        v-else-if="stamping.r2Key"
                        :src="`/api/media/${stamping.r2Key}`"
                        alt=""
                        class="block max-w-[90px] opacity-90"
                    />
                </span>

                <!-- Note controls. FLOATING over the canvas, not a row above it.
                     As a row it changed the height of the viewport every time
                     something was selected, and the whole board shifted under the
                     pointer — which ate the second click of every double-click, so a
                     note could not be opened for editing at all. -->
                <div
                    v-if="board.editable && board.selectedNote"
                    class="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-default bg-default/95 px-3 py-1.5 shadow-lg backdrop-blur"
                >
                    <span class="text-xs text-dimmed">note</span>
                    <button
                        v-for="colour in NOTE_COLOURS"
                        :key="colour"
                        class="size-4 rounded border border-default"
                        :class="board.selectedNote.color === colour ? 'ring-2 ring-inverted' : ''"
                        :style="{ background: colour }"
                        @click="board.setContent(board.selectedNote!, { color: colour })"
                    />
                    <USeparator orientation="vertical" class="h-4" />
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-a-arrow-down"
                        square
                        title="Smaller text"
                        @click="
                            board.setContent(board.selectedNote!, {
                                fontSize: Math.max(10, (board.selectedNote!.font_size ?? 14) - 2),
                            })
                        "
                    />
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-a-arrow-up"
                        square
                        title="Larger text"
                        @click="
                            board.setContent(board.selectedNote!, {
                                fontSize: Math.min(40, (board.selectedNote!.font_size ?? 14) + 2),
                            })
                        "
                    />
                    <USeparator orientation="vertical" class="h-4" />
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-copy"
                        square
                        title="Copy (Ctrl+C)"
                        @click="board.copy(board.selectedNote!)"
                    />
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-x"
                        square
                        class="ml-auto"
                        title="Deselect (Esc)"
                        @click="board.select(null)"
                    />
                </div>

                <UAlert
                    v-if="board.error || board.notice"
                    :color="board.error ? 'error' : 'info'"
                    variant="solid"
                    class="absolute left-1/2 top-3 z-30 w-[28rem] max-w-[90%] -translate-x-1/2 shadow-lg"
                    :title="board.error || board.notice"
                    close
                    @update:open="((board.error = ''), (board.notice = ''))"
                />

                <!-- Zoom controls float over the canvas rather than living in
                     the toolbar, because they act on what is under them. -->
                <div
                    class="absolute bottom-4 left-4 flex items-center gap-1 rounded-lg border border-default bg-default/90 p-1 backdrop-blur"
                >
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-minus"
                        square
                        @click="zoomBy(1 / 1.2)"
                    />
                    <span class="w-12 text-center font-mono text-xs text-muted"
                        >{{ Math.round(view.scale * 100) }}%</span
                    >
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-plus"
                        square
                        @click="zoomBy(1.2)"
                    />
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-maximize"
                        square
                        title="Fit everything"
                        @click="fitToContents"
                    />
                </div>

                <!-- What the current tool is waiting for, said out loud. -->
                <div
                    v-if="board.tool.kind !== 'select'"
                    class="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-default bg-default/95 px-3 py-1.5 text-xs text-muted shadow-lg backdrop-blur"
                >
                    <UIcon
                        :name="stamping ? 'i-lucide-stamp' : 'i-lucide-spline'"
                        class="size-3.5"
                    />
                    {{
                        stamping
                            ? 'Click to stamp — Esc when you are done'
                            : board.stringFrom
                              ? 'Now pick the other end — Esc to cancel'
                              : 'Pick the first card — Esc to cancel'
                    }}
                    <UButton
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        icon="i-lucide-x"
                        square
                        @click="board.resetTool()"
                    />
                </div>

                <div
                    v-if="board.cards.length === 0 && board.grids.length === 0"
                    class="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                    <p class="text-sm text-dimmed">
                        Empty board — add a note, drop in a picture, or lay out a table.
                    </p>
                </div>

                <!-- Search results float over the canvas so they never fight the
                     outline for the same rail. -->
                <div
                    v-if="results.length"
                    class="absolute right-3 top-3 max-h-[70%] w-72 overflow-y-auto rounded-lg border border-default bg-default/95 p-3 shadow-lg backdrop-blur"
                >
                    <div class="mb-2 flex items-center justify-between">
                        <h2 class="text-sm font-semibold text-highlighted">
                            {{ results.length }} result(s)
                        </h2>
                        <UButton
                            size="xs"
                            variant="ghost"
                            color="neutral"
                            icon="i-lucide-x"
                            square
                            @click="((searchTerm = ''), (results = []))"
                        />
                    </div>
                    <ul class="space-y-2">
                        <li v-for="hit in results" :key="hit.id">
                            <button
                                class="w-full rounded p-2 text-left text-xs hover:bg-elevated"
                                @click="revealCard(hit.id)"
                            >
                                <span class="font-mono text-dimmed">{{ hit.kind }}</span>
                                <span class="mt-1 block whitespace-pre-wrap text-muted">{{
                                    hit.excerpt
                                }}</span>
                            </button>
                        </li>
                    </ul>
                </div>
            </div>

            <BoardOutline v-if="outlineOpen" @card="revealCard" @grid="revealGrid" />
        </div>

        <MediaModal
            v-model:open="media.open"
            :board-id="boardId"
            :mode="media.mode"
            :at="viewportCentre()"
            @added="mediaAdded"
        />
        <ShareModal v-model:open="shareOpen" :board-id="boardId" />
        <SystemModal v-model="systemOpen" />
    </div>
</template>
