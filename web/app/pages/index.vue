<script setup lang="ts">
/**
 * The front door, which decides where you actually want to be.
 *
 * On a deployment nobody has used yet, the useful thing is a board — not an
 * empty list with a button on it — so the first visit makes one and opens it.
 * Once boards exist, dropping into a fresh blank one every time would bury them,
 * so this hands over to the library instead.
 *
 * Both branches resolve DURING RENDER rather than in `onMounted`. Deciding on
 * the client meant the redirect only happened if hydration completed: anything
 * that stalled left the page sitting on "setting out a fresh board" forever,
 * with no error to show and nothing to retry. Here the server answers the very
 * first request with a redirect and the browser arrives somewhere real before it
 * has run any of our JavaScript.
 */
const { data, error } = await useAsyncData(
    'skein:entry',
    async () => {
        const { boards } = await api<{ boards: { id: string }[] }>('/api/boards')
        if (boards.length > 0) return { to: '/boards' }
        const board = await api<{ id: string }>('/api/boards', {
            method: 'POST',
            body: { title: 'Untitled board' },
        })
        return { to: `/b/${board.id}` }
    },
    // This branch can CREATE something, so a replayed cached result would
    // reopen the previous board rather than decide again.
    { getCachedData: () => undefined }
)

if (data.value?.to) {
    await navigateTo(data.value.to, { replace: true })
}
</script>

<template>
    <div class="flex min-h-screen items-center justify-center bg-elevated">
        <div class="space-y-3 text-center">
            <UIcon name="i-lucide-spline" class="size-8 text-primary" />
            <h1 class="text-2xl font-semibold text-highlighted">Skein</h1>
            <template v-if="error">
                <p class="text-sm text-error">{{ error.statusMessage || error.message }}</p>
                <UButton size="sm" @click="reloadNuxtApp()">Try again</UButton>
            </template>
            <p v-else class="text-sm text-muted">Setting out a fresh board…</p>
        </div>
    </div>
</template>
