<script setup lang="ts">
import type { Card } from '~/stores/board'

/**
 * One way in for anything that arrives as a picture.
 *
 * Upload and import used to be two buttons with two shapes — a hidden file input
 * next to a URL field wedged into the toolbar — even though they are the same
 * intention with two sources. Collapsing them means there is one place to stand
 * when this grows: a filter step, or naming the faces the container just found,
 * belongs BETWEEN choosing a file and it landing on the board, and that
 * in-between only exists once the flow has a room of its own.
 */
const open = defineModel<boolean>('open', { default: false })

const props = defineProps<{
    boardId: string
    /** What the picture becomes. A sticker is a cut-out, not a document. */
    mode: 'image' | 'sticker'
    /** Where on the board it should land — the centre of what the user is looking at. */
    at: { x: number; y: number }
}>()

const emit = defineEmits<{ added: [card: Card, recognised: string[]] }>()

const file = ref<File | null>(null)
const url = ref('')
const working = ref<'file' | 'url' | null>(null)
const error = ref('')

/**
 * Closing the modal must actually stop the work, not just hide it.
 *
 * Without this, cancelling a slow import still put the picture on the board a
 * few seconds later — the flow the user had just backed out of, completing
 * behind their back.
 */
let inflight: AbortController | null = null

function reset() {
    inflight?.abort()
    inflight = null
    file.value = null
    url.value = ''
    working.value = null
    error.value = ''
}
watch(open, (isOpen) => !isOpen && reset())

async function send<T>(kind: 'file' | 'url', request: (signal: AbortSignal) => Promise<T>) {
    inflight = new AbortController()
    working.value = kind
    error.value = ''
    try {
        return await request(inflight.signal)
    } catch (e) {
        if ((e as Error)?.name !== 'AbortError') {
            error.value =
                (e as { data?: { message?: string } })?.data?.message ??
                (e as Error).message ??
                'that did not work'
        }
        return undefined
    } finally {
        working.value = null
        inflight = null
    }
}

function done(card: Card | undefined, recognised: string[] = []) {
    if (!card) return
    emit('added', card, recognised)
    open.value = false
}

watch(file, (chosen) => chosen && upload(chosen))

async function upload(chosen: File) {
    const query = new URLSearchParams({
        kind: props.mode,
        x: String(props.at.x),
        y: String(props.at.y),
    })
    const result = await send('file', (signal) =>
        api<{ card: Card; recognised?: string[]; error?: string }>(
            `/api/boards/${props.boardId}/upload?${query.toString()}`,
            {
                method: 'POST',
                body: chosen,
                headers: { 'content-type': 'application/octet-stream' },
                signal,
            }
        )
    )
    file.value = null
    done(result?.card, result?.recognised ?? [])
}

async function fromUrl() {
    if (!url.value.trim()) return
    const result = await send('url', (signal) =>
        api<{ card?: Card; recognised?: string[]; error?: string }>('/api/import', {
            method: 'POST',
            body: {
                url: url.value.trim(),
                boardId: props.boardId,
                kind: props.mode,
                x: props.at.x,
                y: props.at.y,
            },
            signal,
        })
    )
    if (result?.error) error.value = result.error
    else done(result?.card, result?.recognised ?? [])
}
</script>

<template>
    <UModal
        v-model:open="open"
        :title="mode === 'sticker' ? 'New sticker' : 'Add a picture'"
        :description="
            mode === 'sticker'
                ? 'Cut an image down to a stamp you can stick on anything.'
                : 'Dropped on the board where you are looking.'
        "
    >
        <template #body>
            <div class="space-y-4">
                <UFileUpload
                    v-model="file"
                    accept="image/*,application/pdf"
                    icon="i-lucide-image-plus"
                    label="Drop a file here"
                    description="or click to browse — PNG, JPEG, HEIC, WebP or PDF"
                    class="min-h-40 w-full"
                    :disabled="working !== null"
                />

                <USeparator label="or" />

                <UFieldGroup class="w-full">
                    <UInput
                        v-model="url"
                        placeholder="https://…/photo.jpg"
                        icon="i-lucide-link"
                        class="flex-1"
                        :disabled="working !== null"
                        @keyup.enter="fromUrl"
                    />
                    <UButton
                        icon="i-lucide-download"
                        :loading="working === 'url'"
                        :disabled="!url.trim() || working !== null"
                        @click="fromUrl"
                    >
                        Fetch
                    </UButton>
                </UFieldGroup>

                <div
                    v-if="working === 'file'"
                    class="flex items-center gap-2 text-sm text-muted"
                    role="status"
                >
                    <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin" />
                    Decoding, resizing and reading it…
                </div>

                <UAlert v-if="error" color="error" variant="subtle" :title="error" />

                <p class="text-xs text-dimmed">
                    A remote URL is fetched by the image container, not by the Worker — it resolves
                    the address before connecting and re-checks every redirect.
                </p>
            </div>
        </template>
    </UModal>
</template>
