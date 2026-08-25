import withNuxt from './.nuxt/eslint.config.mjs'

export default withNuxt(
    {
        ignores: [
            '.output/**',
            '.nuxt/**',
            '.nitro/**',
            '.cache/**',
            '.data/**',
            '.wrangler/**',
            '.mf/**',
            'dist/**',
        ],
    },
    {
        rules: {
            'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
            // Nuxt auto-imports; TypeScript already checks these.
            'no-undef': 'off',
            // TypeScript's version respects the `_` prefix convention.
            'no-unused-vars': 'off',
            // Prettier writes void elements as `<img …>`; the default here
            // wants `<img … />`. Left alone the two tools rewrite each other's
            // output forever, so the rule yields on voids only.
            'vue/html-self-closing': [
                'warn',
                {
                    html: { void: 'any', normal: 'always', component: 'always' },
                    svg: 'always',
                    math: 'always',
                },
            ],
        },
    }
)
