<script setup lang="ts">
import { stringColour, type Link } from '~/stores/board'

export interface Point {
    x: number
    y: number
}

const props = defineProps<{
    links: Link[]
    /** Centre of each card, keyed by card id. Cards not yet measured are skipped. */
    centres: Record<string, Point>
    /** Canvas zoom, so the cut target stays the same size on screen at any zoom. */
    viewScale: number
}>()

defineEmits<{ cut: [id: string] }>()

const hovered = ref<string | null>(null)
const chrome = computed(() => 1 / Math.max(0.05, props.viewScale))

/**
 * Only strings whose BOTH ends have been measured can be drawn. During the
 * first paint, or right after a card is added, one end may not exist yet — and
 * drawing to a zero point flings a line into the corner.
 */
const drawable = computed(() =>
    props.links
        .map((link) => ({
            link,
            from: props.centres[link.fromCardId],
            to: props.centres[link.toCardId],
        }))
        .filter((s): s is { link: Link; from: Point; to: Point } => Boolean(s.from && s.to))
)
const manual = computed(() => drawable.value.filter((s) => s.link.kind === 'manual'))
const labelled = computed(() => drawable.value.filter((s) => s.link.label))

const midpoint = (from: Point, to: Point) => ({ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 })

/** Push the label off the line so it does not sit under the string. */
function labelAt(from: Point, to: Point) {
    const dx = to.x - from.x
    const dy = to.y - from.y
    const length = Math.hypot(dx, dy) || 1
    return {
        x: (from.x + to.x) / 2 + (-dy / length) * 12 * chrome.value,
        y: (from.y + to.y) / 2 + (dx / length) * 12 * chrome.value,
    }
}
</script>

<template>
    <!-- TWO layers, deliberately. Lines sit BEHIND the cards, so a string tucks
         under a photograph the way it would on a real board. Labels and the cut
         target sit IN FRONT of the lines but still behind every card, because a
         string must never win a fight with the thing it is attached to.
         Both svgs ignore pointer events; only the pieces that are meant to be
         clicked opt back in. -->
    <svg class="pointer-events-none absolute inset-0 z-0 size-full overflow-visible">
        <line
            v-for="{ link, from, to } in drawable"
            :key="link.id"
            :x1="from.x"
            :y1="from.y"
            :x2="to.x"
            :y2="to.y"
            :stroke="stringColour(link.color)"
            :stroke-width="(link.kind === 'person' ? 1.5 : 2.5) * chrome"
            :stroke-dasharray="link.kind === 'person' ? `${6 * chrome} ${5 * chrome}` : undefined"
            :opacity="link.kind === 'person' ? 0.75 : hovered === link.id ? 1 : 0.95"
        />
    </svg>

    <svg class="pointer-events-none absolute inset-0 z-[500] size-full overflow-visible">
        <!-- A string is a line one or two pixels wide, which is not something a
             person can be asked to click. The hit target is a transparent stroke
             an order of magnitude thicker, and the scissors only appear once the
             pointer is actually on it. -->
        <g v-for="{ link, from, to } in manual" :key="link.id">
            <line
                :x1="from.x"
                :y1="from.y"
                :x2="to.x"
                :y2="to.y"
                stroke="transparent"
                :stroke-width="14 * chrome"
                class="pointer-events-auto cursor-pointer"
                @pointerenter="hovered = link.id"
                @pointerleave="hovered === link.id && (hovered = null)"
                @click.stop="$emit('cut', link.id)"
            />
            <g
                v-if="hovered === link.id"
                class="pointer-events-auto cursor-pointer"
                @pointerenter="hovered = link.id"
                @pointerleave="hovered = null"
                @click.stop="$emit('cut', link.id)"
            >
                <title>Cut this string</title>
                <circle
                    :cx="midpoint(from, to).x"
                    :cy="midpoint(from, to).y"
                    :r="11 * chrome"
                    fill="var(--ui-bg)"
                    :stroke="stringColour(link.color)"
                    :stroke-width="1.5 * chrome"
                />
                <foreignObject
                    :x="midpoint(from, to).x - 7 * chrome"
                    :y="midpoint(from, to).y - 7 * chrome"
                    :width="14 * chrome"
                    :height="14 * chrome"
                >
                    <UIcon name="i-lucide-scissors" class="size-full text-error" />
                </foreignObject>
            </g>
        </g>

        <text
            v-for="{ link, from, to } in labelled"
            :key="`label-${link.id}`"
            :x="labelAt(from, to).x"
            :y="labelAt(from, to).y"
            text-anchor="middle"
            :fill="stringColour(link.color)"
            :style="{ fontSize: `${11 * chrome}px`, strokeWidth: `${4 * chrome}px` }"
            class="font-medium [paint-order:stroke] [stroke-linejoin:round] [stroke:var(--ui-bg)]"
        >
            {{ link.label }}
        </text>
    </svg>
</template>
