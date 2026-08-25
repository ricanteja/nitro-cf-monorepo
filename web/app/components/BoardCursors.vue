<script setup lang="ts">
/**
 * Everyone else's pointer, drawn on the board.
 *
 * Inside the transformed board layer, so a cursor is anchored to the PLACE it is
 * pointing at rather than to a position on someone else's screen — two people at
 * different zooms are then genuinely looking at the same spot. The arrow itself
 * is scaled back out so it stays the size of a cursor instead of growing into a
 * billboard when you zoom in.
 */
const props = defineProps<{ viewScale: number }>()
const board = useBoardStore()

const chrome = computed(() => 1 / Math.max(0.05, props.viewScale))
const others = computed(() => [...board.cursors.values()])
</script>

<template>
    <div class="pointer-events-none absolute inset-0 z-[4000]">
        <div
            v-for="cursor in others"
            :key="cursor.id"
            class="absolute"
            :style="{
                left: `${cursor.x}px`,
                top: `${cursor.y}px`,
                transform: `scale(${chrome})`,
                transformOrigin: 'top left',
                transition: 'left 90ms linear, top 90ms linear',
            }"
        >
            <svg width="18" height="18" viewBox="0 0 18 18" class="drop-shadow">
                <path
                    d="M2 1 L2 14 L5.6 10.6 L8 16 L10.6 15 L8.2 9.8 L13 9.6 Z"
                    :fill="cursor.colour"
                    stroke="white"
                    stroke-width="1.2"
                    stroke-linejoin="round"
                />
            </svg>
            <span
                class="absolute left-4 top-4 whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium text-white shadow"
                :style="{ background: cursor.colour }"
            >
                {{ cursor.name }}
            </span>
        </div>
    </div>
</template>
