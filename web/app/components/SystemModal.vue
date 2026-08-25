<script setup lang="ts">
/**
 * The cog: appearance, and what the app is actually running on.
 *
 * The theme switch used to sit in the toolbar between the share button and the
 * cog, where it competed for attention with the tools. It is a preference, not
 * a tool — set once, then never again — so it belongs behind the same cog as
 * everything else in that category.
 */
const open = defineModel<boolean>({ default: false })

const colorMode = useColorMode()
const THEMES = [
    { value: 'light', icon: 'i-lucide-sun', label: 'Light' },
    { value: 'dark', icon: 'i-lucide-moon', label: 'Dark' },
    { value: 'system', icon: 'i-lucide-monitor', label: 'System' },
]

// NOT awaited. `immediate: false` means there is nothing to wait for, and an
// awaited setup turns this into an async component — one more thing that has to
// resolve before the board can paint.
const { data: health, refresh, status } = useFetch('/api/health', { immediate: false })
watch(open, (isOpen) => isOpen && refresh())
</script>

<template>
    <UModal v-model:open="open" title="System">
        <template #body>
            <div class="space-y-5">
                <section class="space-y-2">
                    <h3 class="text-sm font-semibold text-highlighted">Appearance</h3>
                    <UFieldGroup size="sm">
                        <UButton
                            v-for="theme in THEMES"
                            :key="theme.value"
                            :icon="theme.icon"
                            :color="colorMode.preference === theme.value ? 'primary' : 'neutral'"
                            :variant="colorMode.preference === theme.value ? 'solid' : 'subtle'"
                            @click="colorMode.preference = theme.value"
                        >
                            {{ theme.label }}
                        </UButton>
                    </UFieldGroup>
                </section>

                <USeparator />

                <section class="space-y-3">
                    <h3 class="text-sm font-semibold text-highlighted">Infrastructure</h3>
                    <p class="text-sm text-muted">
                        Skein is a demo for a Nitro preset and a per-PR deployment pipeline. This
                        panel is the honest bit: it exercises the Cloudflare bindings for real
                        rather than checking that they exist.
                    </p>

                    <UCard>
                        <template #header>
                            <div class="flex items-center justify-between">
                                <h4 class="text-sm font-semibold text-highlighted">Bindings</h4>
                                <UBadge
                                    :color="health?.healthy ? 'success' : 'error'"
                                    variant="subtle"
                                >
                                    {{ health?.healthy ? 'healthy' : 'unhealthy' }}
                                </UBadge>
                            </div>
                        </template>
                        <dl class="space-y-2 font-mono text-sm">
                            <div
                                v-for="(result, name) in health?.checks ?? {}"
                                :key="name"
                                class="flex items-baseline justify-between gap-4"
                            >
                                <dt class="uppercase text-muted">{{ name }}</dt>
                                <dd class="text-right text-highlighted">{{ result }}</dd>
                            </div>
                        </dl>
                        <template #footer>
                            <div class="flex items-center justify-between gap-3">
                                <p class="font-mono text-xs text-dimmed">
                                    env: {{ (health?.bindings ?? []).join(', ') || 'none' }}
                                </p>
                                <UButton
                                    size="xs"
                                    variant="subtle"
                                    :loading="status === 'pending'"
                                    @click="refresh()"
                                >
                                    Re-check
                                </UButton>
                            </div>
                        </template>
                    </UCard>

                    <div class="grid grid-cols-2 gap-2 text-xs text-muted">
                        <div class="rounded border border-default p-2">
                            <p class="font-medium text-highlighted">D1</p>
                            <p>boards, cards, people, faces, links, and an FTS5 search index</p>
                        </div>
                        <div class="rounded border border-default p-2">
                            <p class="font-medium text-highlighted">R2</p>
                            <p>uploaded originals and the thumbnails the container produces</p>
                        </div>
                        <div class="rounded border border-default p-2">
                            <p class="font-medium text-highlighted">Durable Object</p>
                            <p>live layout, presence, per-person undo, write-behind to D1</p>
                        </div>
                        <div class="rounded border border-default p-2">
                            <p class="font-medium text-highlighted">Container</p>
                            <p>HEIC and PDF decoding, OCR, face detection, guarded URL fetch</p>
                        </div>
                    </div>
                </section>
            </div>
        </template>
    </UModal>
</template>
