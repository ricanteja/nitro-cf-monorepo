<script setup lang="ts">
const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ boardId: string }>()

/**
 * Sharing, arranged the way people already expect it.
 *
 * The previous version offered two buttons that each minted a link, which put
 * the question the wrong way round: you had to decide which credential to
 * create before you could see what you were copying. Here there is ONE link and
 * a control that says what it lets people do — change the permission and the
 * link you are about to copy changes with it.
 */
const PERMISSIONS = [
    { label: 'Viewer', value: 'view' as const, icon: 'i-lucide-eye' },
    { label: 'Editor', value: 'edit' as const, icon: 'i-lucide-pencil' },
]

const permission = ref<'view' | 'edit'>('view')
const tokens = ref<Record<string, string>>({})
const minting = ref(false)
const copied = ref(false)
const error = ref('')

const token = computed(() => tokens.value[permission.value])
const shareUrl = computed(() =>
    token.value && import.meta.client
        ? `${window.location.origin}/b/${props.boardId}?t=${token.value}`
        : ''
)

/**
 * Mint on demand, and only once per permission.
 *
 * A link is a credential: every extra one is another way in that nothing is
 * tracking, so opening this dialog must not create anything by itself. The
 * server reuses an existing link of the same permission for the same reason.
 */
async function ensure(): Promise<void> {
    if (tokens.value[permission.value]) return
    minting.value = true
    error.value = ''
    try {
        const share = await api<{ token: string; permission: string }>(
            `/api/boards/${props.boardId}/share`,
            { method: 'POST', body: { permission: permission.value } }
        )
        tokens.value[share.permission] = share.token
    } catch (e) {
        error.value = (e as Error).message
    } finally {
        minting.value = false
    }
}

watch(open, async (isOpen) => {
    copied.value = false
    if (!isOpen) return
    const existing = await api<{ shares: { token: string; permission: string }[] }>(
        `/api/boards/${props.boardId}/shares`
    ).catch(() => null)
    tokens.value = Object.fromEntries((existing?.shares ?? []).map((s) => [s.permission, s.token]))
    await ensure()
})
watch(permission, () => {
    copied.value = false
    void ensure()
})

async function copy() {
    if (!shareUrl.value) return
    try {
        await navigator.clipboard.writeText(shareUrl.value)
        copied.value = true
        setTimeout(() => (copied.value = false), 1600)
    } catch {
        error.value = 'Your browser would not let the page write to the clipboard.'
    }
}
</script>

<template>
    <UModal v-model:open="open" title="Share this board">
        <template #body>
            <div class="space-y-4">
                <div class="flex items-center justify-between gap-3">
                    <div class="flex items-center gap-2">
                        <UIcon name="i-lucide-globe" class="size-5 text-muted" />
                        <div>
                            <p class="text-sm font-medium text-highlighted">Anyone with the link</p>
                            <p class="text-xs text-muted">No sign-in, no account.</p>
                        </div>
                    </div>
                    <USelect
                        v-model="permission"
                        :items="PERMISSIONS"
                        value-key="value"
                        size="sm"
                        class="w-32"
                    />
                </div>

                <UFieldGroup class="w-full">
                    <UInput
                        :model-value="shareUrl"
                        readonly
                        :loading="minting"
                        placeholder="minting a link…"
                        class="flex-1 font-mono"
                        @focus="(e: FocusEvent) => (e.target as HTMLInputElement).select()"
                    />
                    <UButton
                        :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                        :color="copied ? 'success' : 'primary'"
                        :disabled="!shareUrl"
                        @click="copy"
                    >
                        {{ copied ? 'Copied' : 'Copy' }}
                    </UButton>
                </UFieldGroup>

                <UAlert v-if="error" color="error" variant="subtle" :title="error" />

                <UAlert
                    v-if="permission === 'edit'"
                    color="warning"
                    variant="subtle"
                    icon="i-lucide-triangle-alert"
                    title="An edit link is a credential"
                    description="Whoever holds it can change this board. There is no way to take it back — this demo has no session layer to revoke one."
                />
            </div>
        </template>
    </UModal>
</template>
