<script setup lang="ts">
import type { Grid } from '~/stores/board'

defineProps<{ grid: Grid; editable: boolean }>()
defineEmits<{ grab: [event: PointerEvent]; remove: [] }>()
</script>

<template>
    <!-- Tables live on the bottom layer: cards are dropped ONTO them, so they
         must never sit above the thing being dropped. -->
    <div
        class="group absolute rounded-lg border-2 border-dashed border-default bg-elevated/60 backdrop-blur-[1px]"
        :style="{
            left: `${grid.x}px`,
            top: `${grid.y}px`,
            width: `${grid.width}px`,
            height: `${grid.height}px`,
            zIndex: 0,
        }"
    >
        <div
            class="flex cursor-grab items-center gap-2 border-b border-default px-3 py-1.5 active:cursor-grabbing"
            @pointerdown="$emit('grab', $event)"
        >
            <UIcon name="i-lucide-table" class="size-3.5 text-dimmed" />
            <span class="text-xs font-medium text-muted">{{ grid.title || 'Table' }}</span>
            <UButton
                v-if="editable"
                icon="i-lucide-x"
                size="xs"
                variant="ghost"
                square
                class="ml-auto opacity-0 transition group-hover:opacity-100"
                @pointerdown.stop
                @click.stop="$emit('remove')"
            />
        </div>

        <div class="flex h-[calc(100%-2rem)]">
            <div
                v-if="grid.rows.some((r) => r.label)"
                class="flex w-16 shrink-0 flex-col border-e border-default"
            >
                <div
                    v-for="row in grid.rows"
                    :key="row.id"
                    class="flex flex-1 items-center justify-center border-b border-default text-sm font-semibold text-muted last:border-b-0"
                >
                    {{ row.label }}
                </div>
            </div>
            <div class="flex flex-1 flex-col">
                <div v-if="grid.columns.some((c) => c.label)" class="flex border-b border-default">
                    <div
                        v-for="column in grid.columns"
                        :key="column.id"
                        class="flex-1 px-2 py-1 text-center text-xs font-medium text-muted"
                    >
                        {{ column.label }}
                    </div>
                </div>
                <div class="flex flex-1">
                    <!-- Cells are drop targets only; the cards themselves are
                         rendered by the board so they can be dragged between
                         tables and open space without changing parents. -->
                    <div
                        v-for="column in grid.columns"
                        :key="column.id"
                        class="flex-1 border-e border-default last:border-e-0"
                    />
                </div>
            </div>
        </div>
    </div>
</template>
