import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    { ignores: ['node_modules/**', '.wrangler/**'] },
    {
        rules: {
            'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
            '@typescript-eslint/no-unused-vars': [
                'error',
                { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
            ],
        },
    }
)
