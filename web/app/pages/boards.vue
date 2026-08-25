<script setup lang="ts">
interface BoardSummary {
    id: string
    title: string
    created_at: number
    card_count: number
}

/**
 * The library.
 *
 * There is no sign-in, so "your boards" means every board this deployment holds
 * — which is honest for a demo and worth saying out loud on the page rather than
 * letting someone discover it. Everything here is deliberately plain: a list, a
 * button that makes a new one, and a way to get rid of one.
 */
const { data, refresh, status } = await useFetch<{ boards: BoardSummary[] }>('/api/boards')
const boards = computed(() => data.value?.boards ?? [])

const creating = ref(false)
const removing = ref<string | null>(null)
const doomed = ref<BoardSummary | null>(null)
const error = ref('')

async function create() {
    creating.value = true
    error.value = ''
    try {
        const board = await api<{ id: string }>('/api/boards', {
            method: 'POST',
            body: { title: 'Untitled board' },
        })
        await navigateTo(`/b/${board.id}`)
    } catch (e) {
        error.value = (e as Error).message
        creating.value = false
    }
}

/**
 * Deleting asks first, and this is the one place in the app that does.
 *
 * Everything else on a board can be put back — a card is one action, and layout
 * has undo behind it. A board is the whole thing at once, and nothing here can
 * restore it.
 */
async function remove() {
    const board = doomed.value
    if (!board) return
    removing.value = board.id
    error.value = ''
    try {
        await api(`/api/boards/${board.id}`, { method: 'DELETE' })
        doomed.value = null
        await refresh()
    } catch (e) {
        error.value = (e as Error).message
    } finally {
        removing.value = null
    }
}

const when = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

useHead({ title: 'Skein — boards' })
</script>

<template>
    <div class="min-h-screen bg-elevated">
        <header class="border-b border-default bg-default">
            <div class="mx-auto flex max-w-3xl items-center gap-3 px-6 py-4">
                <UIcon name="i-lucide-spline" class="size-6 text-primary" />
                <div class="mr-auto">
                    <h1 class="text-lg font-semibold text-highlighted">Skein</h1>
                    <p class="text-xs text-muted">
                        Pin things to a board and see what connects them.
                    </p>
                </div>
                <UButton icon="i-lucide-plus" :loading="creating" @click="create">
                    New board
                </UButton>
            </div>
        </header>

        <main class="mx-auto max-w-3xl px-6 py-6">
            <UAlert v-if="error" color="error" variant="subtle" :title="error" class="mb-4" />

            <div v-if="status === 'pending' && !boards.length" class="space-y-2" aria-busy="true">
                <USkeleton v-for="n in 3" :key="n" class="h-16 w-full" />
            </div>

            <div
                v-else-if="!boards.length"
                class="rounded-lg border border-dashed border-default p-10 text-center"
            >
                <UIcon name="i-lucide-layout-dashboard" class="size-8 text-dimmed" />
                <p class="mt-2 text-sm text-muted">No boards yet.</p>
                <UButton class="mt-4" icon="i-lucide-plus" :loading="creating" @click="create">
                    Make the first one
                </UButton>
            </div>

            <ul v-else class="space-y-2">
                <li
                    v-for="board in boards"
                    :key="board.id"
                    class="group flex items-center gap-3 rounded-lg border border-default bg-default p-3 transition hover:border-accented"
                >
                    <NuxtLink :to="`/b/${board.id}`" class="flex min-w-0 flex-1 items-center gap-3">
                        <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-md bg-elevated"
                        >
                            <UIcon name="i-lucide-layout-dashboard" class="size-5 text-muted" />
                        </span>
                        <span class="min-w-0">
                            <span class="block truncate text-sm font-medium text-highlighted">
                                {{ board.title }}
                            </span>
                            <span class="block font-mono text-[11px] text-dimmed">
                                {{ board.card_count }} card(s) · {{ when(board.created_at) }}
                            </span>
                        </span>
                    </NuxtLink>
                    <UButton
                        icon="i-lucide-trash-2"
                        size="xs"
                        variant="ghost"
                        color="neutral"
                        square
                        :aria-label="`Delete ${board.title}`"
                        class="opacity-0 transition group-hover:opacity-100 hover:text-error focus-visible:opacity-100"
                        @click="doomed = board"
                    />
                </li>
            </ul>

            <p class="mt-6 text-xs text-dimmed">
                Every board on this deployment is listed here. There is no sign-in — this is a demo
                of a deployment pipeline, not a product.
            </p>
        </main>

        <UModal
            :open="doomed !== null"
            title="Delete this board?"
            :description="
                doomed
                    ? `“${doomed.title}” and its ${doomed.card_count} card(s) go for good. There is no undo for this.`
                    : ''
            "
            @update:open="doomed = null"
        >
            <template #footer>
                <div class="flex justify-end gap-2">
                    <UButton variant="ghost" color="neutral" @click="doomed = null">Cancel</UButton>
                    <UButton color="error" :loading="removing !== null" @click="remove">
                        Delete
                    </UButton>
                </div>
            </template>
        </UModal>
    </div>
</template>
