import tailwindcss from '@tailwindcss/vite'
// Type-only import: pulls in the `cloudflareMonorepo` augmentation of
// NitroConfig so the block at the bottom of this file typechecks.
import type {} from 'nitro-cloudflare-monorepo'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: '2026-08-01',
    devtools: { enabled: true },
    modules: ['@nuxt/eslint', '@nuxt/ui', '@pinia/nuxt'],
    css: ['~/assets/css/main.css'],
    devServer: {
        host: '0.0.0.0',
        port: 3000,
    },
    app: {
        head: {
            title: 'Skein',
            htmlAttrs: { lang: 'en' },
        },
    },
    vite: {
        plugins: [tailwindcss()],
    },
    nitro: {
        /**
         * Both `preset` and `extends` are required, and this is not redundancy.
         *
         * Nitro resolves presets through an internal registry BEFORE it loads
         * external packages, so in dev an external preset is quietly ignored
         * and replaced with `nitro-dev`. `preset` therefore has to name a
         * built-in for the production build to come out right, while `extends`
         * is what actually gets our dev module loaded.
         */
        preset: 'cloudflare-module',
        extends: ['nitro-cloudflare-monorepo'],
        compatibilityDate: '2026-08-01',
        cloudflare: {
            // wrangler.jsonc is hand-written and authoritative; do not let the
            // preset generate one over the top of it.
            deployConfig: false,
            nodeCompat: true,
        },
        cloudflareMonorepo: {
            /**
             * Answers WebSocket upgrades above Nitro, so the browser's socket
             * reaches the board Durable Object over the `BOARD` binding instead
             * of over a second public hostname. Same module in development and
             * in production — see server/upgrade.ts.
             */
            upgrade: './server/upgrade.ts',

            // Auxiliary workers. Each is read from its own wrangler config,
            // bundled, and loaded into the SAME Miniflare instance as this app
            // — which is what makes the cross-script Durable Object binding
            // below resolvable in local development.
            workers: [
                { configPath: '../services/board/wrangler.jsonc' },
                // Carries a container, so the preset builds its image before
                // starting Miniflare. Needs Docker; without it the preset logs
                // a warning, disables containers and leaves the rest of dev
                // working.
                { configPath: '../services/imgman/wrangler.jsonc' },
            ],
        },
    },
})
