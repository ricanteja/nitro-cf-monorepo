import eslint from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    { ignores: ['node_modules/**', '.wrangler/**'] },
    {
        // src/ is a Worker.
        files: ['src/**/*.ts'],
        rules: {
            'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    },
    {
        // container/ is plain Node inside the image — a different runtime with
        // a different global scope, so it gets its own environment rather than
        // the Worker one. `console.log` is how a container reports itself to
        // `docker logs`, so it is allowed here and nowhere else.
        files: ['container/**/*.mjs'],
        languageOptions: {
            globals: globals.node,
            sourceType: 'module',
            ecmaVersion: 2023,
        },
        rules: {
            'no-console': 'off',
        },
    }
)
