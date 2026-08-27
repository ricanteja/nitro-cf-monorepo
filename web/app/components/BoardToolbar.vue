<script setup lang="ts">
import type { VNode } from 'vue'
import type { Peer } from '~/stores/board'

const board = useBoardStore()

/**
 * Renaming happens here rather than in a dialog.
 *
 * The library lists boards by title, so a wall of "Untitled board" makes leaving
 * one pointless — you would never find it again. The title is the one thing
 * about the board itself worth editing, and the place you already look for it is
 * the place it is written.
 */
const renaming = ref(false)
const draft = ref('')

function startRename() {
    if (!board.editable) return
    draft.value = board.title
    renaming.value = true
}

function commitRename() {
    renaming.value = false
    board.rename(draft.value)
}

/**
 * Focus the rename box and select what is in it.
 *
 * Deferred by a frame on purpose. The input is mounted while the click that
 * opened it is still being dispatched, and the tail of that click puts the caret
 * where the pointer is — so selecting immediately gets undone, and typing
 * appends to the old title instead of replacing it.
 */
const selectEl = (vnode: VNode) => {
    const el = vnode.el as HTMLInputElement | null
    if (el) requestAnimationFrame(() => (el.focus(), el.select()))
}

const emit = defineEmits<{
    addNote: []
    addImage: []
    importSticker: []
    addTable: [preset: 'plain' | 'tier' | 'kanban']
    search: [term: string]
    toggleOutline: []
    share: []
    system: []
}>()

const term = defineModel<string>('term', { default: '' })
defineProps<{ searching: boolean; outlineOpen: boolean }>()

const EMOJI = ['📌', '⭐', '🔥', '❗', '❓', '✅', '🔎', '💡', '🧩', '☕', '🕐', '💬']

/** Beyond this the cluster becomes a smear; the rest are counted instead. */
const MAX_AVATARS = 4

/**
 * Kept in step with MAX_EDITORS in the board Durable Object, which is where it
 * is actually enforced. Shown only once the limit is reached, so the number
 * appears at the moment it starts to matter rather than as trivia.
 */
const MAX_EDITORS = 8

const editorCount = computed(() => board.peers.filter((p) => p.role === 'edit').length)

/**
 * What somebody is doing, from state the board already has.
 *
 * Nothing is sent for this: a gesture is announced for the mirroring, and a
 * draft for the live text. Naming them here costs one lookup each and turns a
 * list of who is present into a list of what is happening.
 */
function doing(peer: Peer): string {
    for (const draft of board.drafts.values()) {
        if (draft.actor === peer.id) return 'writing a note'
    }
    const gesture = board.gestures.get(peer.id)
    if (gesture) {
        return gesture.mode === 'move'
            ? 'moving something'
            : gesture.mode === 'rotate'
              ? 'rotating something'
              : 'resizing something'
    }
    // Your own row says so, because the name above it is an input rather than
    // a "(you)" label — this is what marks which row is yours.
    if (peer.id === board.me?.id) return board.editable ? 'you — can edit' : 'you — viewing'
    return peer.role === 'edit' ? 'can edit' : 'viewing'
}
/**
 * Your own name, editable in place in the presence list.
 *
 * Seeded from `me` and re-seeded whenever it changes underneath — which happens
 * on the first `welcome`, on a reconnect, and after the Durable Object trims
 * what was typed. Guarded on focus so a presence broadcast arriving mid-edit
 * does not overwrite what is being typed.
 */
const nameDraft = ref('')
const nameInput = useTemplateRef<HTMLInputElement>('nameInput')

watch(
    () => board.me?.name,
    (name) => {
        if (name && document.activeElement !== nameInput.value) nameDraft.value = name
    },
    { immediate: true }
)

function commitName() {
    // `renameSelf` answers false for an empty or unchanged name; either way the
    // input goes back to showing the name the room knows, so an emptied field
    // does not sit there looking like it saved.
    if (!board.renameSelf(nameDraft.value)) nameDraft.value = board.me?.name ?? ''
    nameInput.value?.blur()
}

function cancelName() {
    nameDraft.value = board.me?.name ?? ''
    nameInput.value?.blur()
}

const INK = ['#dc2626', '#d97706', '#16a34a', '#2563eb', '#7c3aed', '#475569', '#db2777', '#0891b2']

const stickerOpen = ref(false)
const stringing = computed(() => board.tool.kind === 'string')

function stamp(emoji: string) {
    board.setTool({ kind: 'stamp', emoji })
    stickerOpen.value = false
}

const TABLES = [
    [
        { label: 'Plain table', icon: 'i-lucide-table', onSelect: () => emit('addTable', 'plain') },
        {
            label: 'Tier list',
            icon: 'i-lucide-list-ordered',
            onSelect: () => emit('addTable', 'tier'),
        },
        { label: 'Kanban', icon: 'i-lucide-columns-3', onSelect: () => emit('addTable', 'kanban') },
    ],
]
</script>

<template>
    <header
        class="z-10 flex flex-wrap items-center gap-2 border-b border-default bg-default px-4 py-2"
    >
        <UButton
            to="/boards"
            icon="i-lucide-spline"
            size="xs"
            variant="ghost"
            color="neutral"
            square
            title="All boards"
            aria-label="Leave this board"
            class="text-primary"
        />
        <div class="mr-2 min-w-0">
            <input
                v-if="renaming"
                v-model="draft"
                class="w-48 rounded border border-accented bg-default px-1 text-sm font-semibold text-highlighted outline-none"
                @vue:mounted="selectEl"
                @blur="commitRename"
                @keydown.enter="commitRename"
                @keydown.escape="renaming = false"
            />
            <h1
                v-else
                class="truncate text-sm font-semibold text-highlighted"
                :class="board.editable ? 'cursor-text hover:text-primary' : ''"
                :title="board.editable ? 'Click to rename' : undefined"
                @click="startRename"
            >
                {{ board.title || 'Skein' }}
            </h1>
            <p class="font-mono text-[11px] text-dimmed">
                {{ board.cards.length }} card(s) · {{ board.links.length }} string(s)
                <span v-if="!board.editable"> · view only</span>
            </p>
        </div>

        <template v-if="board.editable">
            <UButton size="xs" icon="i-lucide-sticky-note" @click="emit('addNote')">Note</UButton>

            <!-- Stickers are a MODE, not an action: pick one and the pointer
                 carries it until you put it down or press Escape. -->
            <UPopover v-model:open="stickerOpen">
                <UButton
                    size="xs"
                    variant="subtle"
                    icon="i-lucide-smile"
                    :color="board.tool.kind === 'stamp' ? 'primary' : 'neutral'"
                >
                    Sticker
                </UButton>
                <template #content>
                    <div class="w-56 space-y-2 p-2">
                        <UButton
                            size="xs"
                            variant="subtle"
                            icon="i-lucide-image-plus"
                            block
                            @click="((stickerOpen = false), emit('importSticker'))"
                        >
                            Import a picture…
                        </UButton>
                        <USeparator />
                        <div class="grid grid-cols-6 gap-1">
                            <button
                                v-for="emoji in EMOJI"
                                :key="emoji"
                                class="rounded p-1 text-xl leading-none transition hover:bg-elevated"
                                @click="stamp(emoji)"
                            >
                                {{ emoji }}
                            </button>
                        </div>
                    </div>
                </template>
            </UPopover>

            <UButton
                size="xs"
                variant="subtle"
                icon="i-lucide-image-plus"
                @click="emit('addImage')"
            >
                Image
            </UButton>

            <UDropdownMenu :items="TABLES">
                <UButton size="xs" variant="subtle" icon="i-lucide-table">Table</UButton>
            </UDropdownMenu>

            <!-- Split button: the left half arms the tool, the right half says
                 what colour it will draw in. The swatch is on the button itself
                 so the current colour is visible without opening anything. -->
            <UFieldGroup size="xs">
                <UButton
                    :color="stringing ? 'primary' : 'neutral'"
                    :variant="stringing ? 'solid' : 'subtle'"
                    @click="board.setTool(stringing ? { kind: 'select' } : { kind: 'string' })"
                >
                    <span
                        class="size-3 rounded-full ring-1 ring-inset ring-black/20"
                        :style="{ background: board.inkColour }"
                    />
                    <!-- The label stays put while the tool is armed. It used to
                         change to whatever the tool was waiting for, which made
                         the button hard to find again — and the status pill over
                         the canvas already says that, next to the board where
                         the answer has to be given. -->
                    String
                </UButton>
                <UPopover>
                    <UButton
                        icon="i-lucide-chevron-down"
                        color="neutral"
                        variant="subtle"
                        square
                        aria-label="String colour"
                    />
                    <template #content>
                        <div class="w-56 space-y-3 p-3">
                            <UColorPicker v-model="board.inkColour" size="sm" class="w-full" />
                            <div class="grid grid-cols-8 gap-1.5">
                                <button
                                    v-for="colour in INK"
                                    :key="colour"
                                    class="size-5 rounded-full ring-1 ring-inset ring-black/20 transition"
                                    :class="
                                        board.inkColour.toLowerCase() === colour
                                            ? 'ring-2 ring-offset-2 ring-offset-default ring-inverted'
                                            : ''
                                    "
                                    :style="{ background: colour }"
                                    @click="board.inkColour = colour"
                                />
                            </div>
                        </div>
                    </template>
                </UPopover>
            </UFieldGroup>

            <UFieldGroup size="xs">
                <UButton
                    variant="ghost"
                    color="neutral"
                    icon="i-lucide-undo-2"
                    square
                    :disabled="!board.canUndo"
                    title="Undo (Ctrl+Z)"
                    @click="board.undo()"
                />
                <UButton
                    variant="ghost"
                    color="neutral"
                    icon="i-lucide-redo-2"
                    square
                    :disabled="!board.canRedo"
                    title="Redo (Ctrl+Shift+Z)"
                    @click="board.redo()"
                />
            </UFieldGroup>
        </template>

        <div class="ml-auto flex items-center gap-2">
            <UInput
                v-model="term"
                placeholder="search…"
                icon="i-lucide-search"
                size="xs"
                class="w-40"
                :loading="searching"
                @keyup.enter="emit('search', term)"
            />
            <!-- Presence. The cluster says how many people are here; opening it
                 says who, which of them can edit, and what each is doing right
                 now — and lets you change your own name, which is generated on
                 first visit rather than chosen. -->
            <UPopover v-if="board.peers.length">
                <button
                    class="flex -space-x-1.5 rounded-full p-0.5 transition hover:bg-elevated"
                    :aria-label="`${board.peers.length} here`"
                >
                    <span
                        v-for="peer in board.peers.slice(0, MAX_AVATARS)"
                        :key="peer.id"
                        class="flex size-6 items-center justify-center rounded-full border-2 border-default text-[10px] font-bold text-white"
                        :style="{ background: peer.colour }"
                    >
                        {{ initialsOf(peer.name) }}
                    </span>
                    <span
                        v-if="board.peers.length > MAX_AVATARS"
                        class="flex size-6 items-center justify-center rounded-full border-2 border-default bg-inverted text-[10px] font-bold text-inverted"
                    >
                        +{{ board.peers.length - MAX_AVATARS }}
                    </span>
                </button>
                <template #content>
                    <div class="w-64 p-2">
                        <p class="px-2 pb-1 text-[11px] uppercase tracking-wide text-dimmed">
                            {{ board.peers.length }} here
                        </p>
                        <ul>
                            <li
                                v-for="peer in board.peers"
                                :key="peer.id"
                                class="flex items-center gap-2 rounded px-2 py-1.5"
                            >
                                <span
                                    class="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                                    :style="{ background: peer.colour }"
                                >
                                    {{ initialsOf(peer.name) }}
                                </span>
                                <span class="min-w-0 flex-1">
                                    <!-- Your own row is an input; everyone
                                         else's is text. One row, two states,
                                         rather than a separate settings field
                                         for a name that is only meaningful
                                         next to the people it distinguishes
                                         you from. -->
                                    <input
                                        v-if="peer.id === board.me?.id"
                                        ref="nameInput"
                                        v-model="nameDraft"
                                        :maxlength="board.MAX_NAME_LENGTH"
                                        aria-label="Your name"
                                        class="block w-full truncate rounded bg-transparent text-sm text-highlighted outline-none hover:bg-elevated focus:bg-elevated focus:ring-1 focus:ring-primary"
                                        @blur="commitName"
                                        @keydown.enter.prevent="commitName"
                                        @keydown.escape.prevent="cancelName"
                                    />
                                    <span v-else class="block truncate text-sm text-highlighted">
                                        {{ peer.name }}
                                    </span>
                                    <span class="block text-[11px] text-muted">
                                        {{ doing(peer) }}
                                    </span>
                                </span>
                                <UIcon
                                    :name="
                                        peer.role === 'edit' ? 'i-lucide-pencil' : 'i-lucide-eye'
                                    "
                                    class="size-3.5 shrink-0 text-dimmed"
                                    :aria-label="peer.role === 'edit' ? 'can edit' : 'viewing only'"
                                />
                            </li>
                        </ul>
                        <p
                            v-if="editorCount >= MAX_EDITORS"
                            class="px-2 pt-1 text-[11px] text-muted"
                        >
                            {{ MAX_EDITORS }} editors is the limit — anyone else joins as a viewer.
                        </p>
                    </div>
                </template>
            </UPopover>
            <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-panel-right"
                square
                :class="outlineOpen ? 'text-primary' : ''"
                title="Outline"
                @click="emit('toggleOutline')"
            />
            <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-share-2"
                square
                title="Share"
                @click="emit('share')"
            />
            <UButton
                size="xs"
                variant="ghost"
                color="neutral"
                icon="i-lucide-settings"
                square
                title="System"
                @click="emit('system')"
            />
        </div>
    </header>
</template>
