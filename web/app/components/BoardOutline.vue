<script setup lang="ts">
import type { TreeItem } from '@nuxt/ui'
import type { Card, Grid } from '~/stores/board'

/**
 * What is on the board, as a list.
 *
 * A canvas is very good at showing relationships and very bad at answering "is
 * that photograph still here?" once it is off screen. The outline is the other
 * view of the same data — and the tree mirrors what the board actually contains:
 * tables sit ON the board, so they are inside it here too, with whatever they
 * hold nested underneath. Stickers nest under the card they are stuck to,
 * because that is what being stuck to something means.
 *
 * People are a separate section rather than a third kind of container. A person
 * is not somewhere on the board; a person is an index INTO it, and the same card
 * legitimately appears under two of them.
 */
const board = useBoardStore()
const emit = defineEmits<{ card: [id: string]; grid: [id: string] }>()

function label(card: Card): string {
    if (card.kind === 'note') return card.text?.trim().split('\n')[0]?.slice(0, 40) || 'empty note'
    if (card.kind === 'sticker') return card.text || 'cut-out'
    const named = board.faces
        .filter((f) => f.cardId === card.id && f.personId)
        .map((f) => board.people.get(f.personId!))
        .filter(Boolean)
    return named.length ? named.join(', ') : 'photograph'
}

const icon = (card: Card) =>
    card.kind === 'note'
        ? 'i-lucide-sticky-note'
        : card.kind === 'sticker'
          ? 'i-lucide-smile'
          : 'i-lucide-image'

/**
 * A card, plus anything pinned to it.
 *
 * `removable` is the interesting argument. The same card shows up under a person
 * as well as under wherever it sits, and a delete button in BOTH places invites
 * the reading that one of them removes it from the person rather than from the
 * board. Only the entry in the place the card actually LIVES offers to delete
 * it.
 */
function node(card: Card, removable = true): TreeItem {
    const stuck = board.cards.filter((c) => c.attached_to === card.id)
    return {
        key: `card:${card.id}`,
        label: label(card),
        icon: icon(card),
        onSelect: () => emit('card', card.id),
        remove: removable && board.editable ? () => board.removeCard(card) : undefined,
        children: stuck.length ? stuck.map((s) => node(s, removable)) : undefined,
    }
}

function gridNode(grid: Grid, attached: Set<string>): TreeItem {
    const inside = board.cards.filter((c) => c.grid_id === grid.id && !attached.has(c.id))
    return {
        key: `grid:${grid.id}`,
        label: `${grid.title || 'Table'} (${inside.length})`,
        icon: 'i-lucide-table',
        defaultExpanded: true,
        onSelect: () => emit('grid', grid.id),
        remove: board.editable ? () => board.removeGrid(grid) : undefined,
        children: inside.map((c) => node(c)),
    }
}

const items = computed<TreeItem[]>(() => {
    const attached = new Set(board.cards.filter((c) => c.attached_to).map((c) => c.id))
    const loose = board.cards.filter((c) => !c.grid_id && !attached.has(c.id))
    const onBoard = [...board.grids.map((g) => gridNode(g, attached)), ...loose.map((c) => node(c))]

    const people: TreeItem[] = []
    for (const [personId, name] of board.people) {
        const appearances = board.faces.filter((f) => f.personId === personId)
        const cards = board.cards.filter((c) => appearances.some((f) => f.cardId === c.id))
        if (cards.length === 0) continue
        people.push({
            key: `person:${personId}`,
            label: `${name} (${cards.length})`,
            icon: 'i-lucide-user',
            children: cards.map((c) => node(c, false)),
        })
    }

    const tree: TreeItem[] = [
        {
            key: 'board',
            label: `On the board (${onBoard.length})`,
            icon: 'i-lucide-layout-dashboard',
            defaultExpanded: true,
            children: onBoard.length ? onBoard : undefined,
        },
    ]
    if (people.length) {
        tree.push({
            key: 'people',
            label: 'People',
            icon: 'i-lucide-users',
            defaultExpanded: true,
            children: people,
        })
    }
    return tree
})

const empty = computed(() => board.cards.length === 0 && board.grids.length === 0)
</script>

<template>
    <aside class="flex w-64 shrink-0 flex-col border-s border-default bg-default">
        <div class="flex items-center justify-between border-b border-default px-3 py-2">
            <h2 class="text-sm font-semibold text-highlighted">Outline</h2>
            <span class="font-mono text-[11px] text-dimmed">{{ board.cards.length }}</span>
        </div>
        <div class="flex-1 overflow-y-auto p-2">
            <p v-if="empty" class="p-3 text-xs text-dimmed">
                Nothing here yet. Anything you add shows up in this list.
            </p>
            <UTree
                v-else
                :items="items"
                :get-key="(item: TreeItem) => String(item.key)"
                :ui="{ link: 'group/row' }"
                size="sm"
                color="primary"
            >
                <!-- Overriding this slot means re-drawing the expand chevron by
                     hand; `ui.linkTrailingIcon()` is the same class the default
                     uses, rotation on open included. -->
                <template #item-trailing="{ item, ui }">
                    <UButton
                        v-if="item.remove"
                        icon="i-lucide-x"
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        square
                        :aria-label="`Delete ${item.label}`"
                        class="-my-1 opacity-0 transition group-hover/row:opacity-100 hover:text-error focus-visible:opacity-100"
                        @click.stop="item.remove()"
                        @pointerdown.stop
                    />
                    <UIcon
                        v-if="item.children?.length"
                        name="i-lucide-chevron-down"
                        :class="ui.linkTrailingIcon()"
                    />
                </template>
            </UTree>
        </div>
    </aside>
</template>
