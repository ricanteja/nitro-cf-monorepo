import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
    entries: [
        { input: 'src/index', name: 'index' },
        { input: 'src/preset', name: 'preset' },
        { input: 'src/dev', name: 'dev' },
        { input: 'src/runtime/', outDir: 'dist/runtime', ext: 'mjs' },
    ],
    declaration: true,
    clean: true,
    failOnWarn: false,
    rollup: {
        emitCJS: false,
    },
    externals: [
        'nitropack',
        'nitro',
        'wrangler',
        'miniflare',
        'cloudflare:workers',
        'esbuild',
        // Aliased by the preset into the CONSUMING Nitro build, so it must not
        // be resolved when this package is built.
        '#cloudflare-monorepo/upgrade',
    ],
})
