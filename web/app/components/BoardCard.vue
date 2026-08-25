<script setup lang="ts">
import type { VNode } from 'vue'
import type { Card, Face } from '~/stores/board'

const props = defineProps<{
    card: Card
    faces: Face[]
    people: Map<string, string>
    editable: boolean
    editing: boolean
    selected: boolean
    naming: string | null
    stringMode: boolean
    stringSource: boolean
    highlighted: boolean
    /** Rendered width, needed to scale face boxes out of full-resolution coordinates. */
    renderedWidth: number
    /**
     * The scale to actually draw at. Usually the card's own, but the canvas
     * inflates it when zoomed far out so cards stay findable rather than
     * dwindling to specks.
     */
    displayScale: number
    /** The canvas zoom, so the handles can cancel it out. */
    viewScale: number
    /** What somebody else is typing into this card at this moment, if anyone is. */
    remoteDraft?: { text: string; name: string; colour: string } | null
}>()

const emit = defineEmits<{
    typing: [text: string]
    grab: [event: PointerEvent]
    resize: [event: PointerEvent]
    rotate: [event: PointerEvent]
    edit: []
    saveText: [text: string]
    remove: []
    nameFace: [face: Face]
    saveName: [face: Face, name: string]
    cancelName: []
}>()

const draft = ref('')
const nameDraft = ref('')

/**
 * Whether this edit has already been committed.
 *
 * Every way out of the editor ends up here, and several of them fire twice:
 * pressing Enter commits and then unmounts the textarea, and unmounting a
 * focused element fires `blur`. Committing twice is mostly harmless and
 * committing after a cancel is not, so the first one to arrive wins.
 */
const committed = ref(false)

watch(
    () => props.editing,
    (on, was) => {
        if (on) {
            draft.value = props.card.text ?? ''
            committed.value = false
            return
        }
        // COMMIT ON CLOSE, whatever closed it.
        //
        // The editor used to be saved by `blur` alone, which meant anything
        // that removed the textarea without the browser reporting a blur first
        // — a selection change, a reload, a parent re-render — took the typing
        // with it. Watching the transition catches every one of those, and the
        // guard above keeps it from fighting the paths that do work.
        if (was && !committed.value) {
            committed.value = true
            emit('saveText', draft.value)
        }
    },
    { immediate: true }
)

/** Keep the note, close the editor. */
function commitNote() {
    if (committed.value) return
    committed.value = true
    emit('saveText', draft.value)
}

/** Throw the edit away and close. */
function cancelNote() {
    committed.value = true
    emit('saveText', props.card.text ?? '')
}
/**
 * One submission per name box.
 *
 * Committing with Enter clears the box, and clearing it fires `blur`, which
 * would submit the same name a second time. Two identical requests racing each
 * other is how you discover that creating a person was not idempotent.
 */
const nameSubmitted = ref(false)

watch(
    () => props.naming,
    (id) => {
        nameSubmitted.value = false
        if (!id) return
        const face = props.faces.find((f) => f.id === id)
        nameDraft.value = face?.personId ? (props.people.get(face.personId) ?? '') : ''
    }
)

function submitName(face: Face) {
    if (nameSubmitted.value) return
    nameSubmitted.value = true
    emit('saveName', face, nameDraft.value)
}

/**
 * What the note SAYS on screen: somebody else's keystrokes if they are typing
 * into it, otherwise what is stored.
 *
 * Live rather than on save, because the interesting half of "somebody else is
 * editing this" is what they are writing, not that they are writing.
 */
const liveText = computed(() => props.remoteDraft?.text ?? props.card.text)

/** `autofocus` is unreliable for an element rendered after the initial load. */
const focusEl = (vnode: VNode) => (vnode.el as HTMLElement | null)?.focus()

/**
 * How much to shrink the handles by.
 *
 * A handle is a child of the card, so it inherits the card's scale AND the
 * canvas zoom — which is why they used to grow into slabs on a scaled-up note
 * and vanish on a zoomed-out board. Cancelling both keeps every handle the same
 * number of screen pixels no matter what is happening around it, which is what
 * a control is for: it belongs to the interface, not to the drawing.
 */
const chrome = computed(() => 1 / Math.max(0.05, props.displayScale * props.viewScale))

/** Positions a handle so its CENTRE lands on the corner, at a fixed screen size. */
function handleAt(corner: { left?: string; top?: string; right?: string; bottom?: string }) {
    return {
        ...corner,
        transform: `translate(${corner.right !== undefined ? '50%' : '-50%'}, ${
            corner.bottom !== undefined ? '50%' : '-50%'
        }) scale(${chrome.value})`,
    }
}

/**
 * Face boxes arrive in the FULL-RESOLUTION image's coordinates, but the board
 * renders a thumbnail at whatever width fits — so everything is scaled by the
 * ratio between the two or the boxes land nowhere near the faces.
 */
function faceStyle(face: Face) {
    const ratio = props.card.width ? props.renderedWidth / props.card.width : 1
    return {
        left: `${face.x * ratio}px`,
        top: `${face.y * ratio}px`,
        width: `${face.w * ratio}px`,
        height: `${face.h * ratio}px`,
    }
}
</script>

<template>
    <div
        :data-card-id="card.id"
        class="group absolute touch-none select-none"
        :class="[
            editing ? 'cursor-text' : 'cursor-grab active:cursor-grabbing',
            stringMode ? 'cursor-crosshair' : '',
            highlighted ? 'animate-pulse' : '',
        ]"
        :style="{
            left: `${card.x}px`,
            top: `${card.y}px`,
            zIndex: (card.kind === 'sticker' ? 2000 : 1000) + card.z,
            transform: `rotate(${card.rotation}deg) scale(${displayScale})`,
            /* CENTRE, not top-left. Rotation pivots here, which is the only
               pivot that behaves the way every other canvas tool does, and it
               also means a card's centre stays put as it is scaled. */
            transformOrigin: 'center',
        }"
        @pointerdown="$emit('grab', $event)"
    >
        <!-- Selection. Drawn as a shadow rather than a border so it costs no
             layout, and sized in inverse-scaled pixels so it stays a hairline at
             every zoom instead of thickening with the card. -->
        <div
            v-if="selected || stringSource || highlighted"
            class="pointer-events-none absolute"
            :style="{
                inset: `${-5 * chrome}px`,
                borderRadius: `${4 * chrome}px`,
                boxShadow: `0 0 0 ${(stringSource ? 3 : 2) * chrome}px ${
                    stringSource ? 'var(--ui-error)' : 'var(--ui-primary)'
                }`,
            }"
        />

        <!-- Controls hang outside the card, so they are the reason the board
             reserves a margin at its edges. Shown for the SELECTED card only:
             on hover they appeared under the pointer on the way to something
             else, and there was no way to tell what a click would act on. -->
        <template v-if="editable && selected && !stringMode">
            <button
                title="Delete"
                class="absolute z-10 flex items-center justify-center rounded-full border border-default bg-default text-error shadow-sm"
                :style="{ ...handleAt({ left: '100%', top: '0%' }), width: '22px', height: '22px' }"
                @pointerdown.stop
                @click.stop="$emit('remove')"
            >
                <UIcon name="i-lucide-x" class="size-3.5" />
            </button>
            <button
                title="Drag to rotate"
                class="absolute z-10 flex cursor-alias items-center justify-center rounded-full border border-default bg-default text-muted shadow-sm"
                :style="{ ...handleAt({ left: '0%', top: '0%' }), width: '22px', height: '22px' }"
                @pointerdown.stop="$emit('rotate', $event)"
            >
                <UIcon name="i-lucide-rotate-cw" class="size-3.5" />
            </button>
            <button
                title="Drag to resize"
                class="absolute z-10 flex cursor-nwse-resize items-center justify-center rounded-full border border-default bg-default text-muted shadow-sm"
                :style="{
                    ...handleAt({ left: '100%', top: '100%' }),
                    width: '22px',
                    height: '22px',
                }"
                @pointerdown.stop="$emit('resize', $event)"
            />
        </template>

        <!-- Who is typing into this card, in their presence colour. Positioned
             like a cursor label rather than inside the note, so it never moves
             the text somebody is reading. -->
        <span
            v-if="remoteDraft"
            class="pointer-events-none absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
            :style="{
                top: `${-18 * chrome}px`,
                left: '0px',
                background: remoteDraft.colour,
                transform: `scale(${chrome})`,
                transformOrigin: 'bottom left',
            }"
        >
            {{ remoteDraft.name }} is typing…
        </span>

        <!-- A note. Colour and font size are per-card so a board can be marked
             up the way a physical one is. -->
        <div
            v-if="card.kind === 'note'"
            class="w-44 rounded-sm p-3 shadow-lg"
            :style="{
                background: card.color || '#fde68a',
                fontSize: `${card.font_size ?? 14}px`,
                color: '#1c1917',
            }"
            @dblclick="editable && $emit('edit')"
        >
            <textarea
                v-if="editing"
                v-model="draft"
                class="w-full resize-none bg-transparent outline-none"
                rows="4"
                @vue:mounted="focusEl"
                @pointerdown.stop
                @input="$emit('typing', draft)"
                @blur="commitNote"
                @keydown.enter.exact.prevent="commitNote"
                @keydown.escape.prevent="cancelNote"
            />
            <p v-else class="min-h-4 whitespace-pre-wrap break-words">
                {{ liveText || 'double-click to write…' }}
            </p>
        </div>

        <!-- A sticker: an emoji, or a cut-out pinned on top of everything. -->
        <div v-else-if="card.kind === 'sticker'" class="drop-shadow-md">
            <span v-if="card.text" class="block text-5xl leading-none">{{ card.text }}</span>
            <img
                v-else-if="card.r2_key"
                :src="`/api/media/${card.r2_key}`"
                alt=""
                draggable="false"
                class="block max-w-[140px]"
            />
        </div>

        <div v-else-if="card.r2_key" class="relative">
            <img
                :src="`/api/media/${card.r2_key}`"
                alt=""
                draggable="false"
                class="block max-w-[240px] rounded-sm border-4 border-white bg-white shadow-lg"
            />
            <div
                v-for="face in faces"
                :key="face.id"
                class="absolute border-2 border-primary/80 bg-primary/5"
                :style="faceStyle(face)"
                @pointerdown.stop
                @click.stop="editable && $emit('nameFace', face)"
            >
                <span
                    v-if="face.personId && naming !== face.id"
                    class="absolute -bottom-5 left-0 whitespace-nowrap rounded bg-primary px-1 text-[10px] text-inverted"
                >
                    {{ people.get(face.personId) }}
                </span>
                <input
                    v-if="naming === face.id"
                    v-model="nameDraft"
                    placeholder="who is this?"
                    class="absolute -bottom-7 left-0 w-36 rounded border border-default bg-default px-1 text-[11px] text-highlighted outline-none"
                    @vue:mounted="focusEl"
                    @pointerdown.stop
                    @keydown.enter="submitName(face)"
                    @keydown.escape="((nameSubmitted = true), emit('cancelName'))"
                    @blur="submitName(face)"
                />
            </div>
        </div>
    </div>
</template>
