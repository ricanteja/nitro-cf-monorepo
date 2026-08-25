import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        ignores: ['dist/**', 'node_modules/**'],
    },
    {
        rules: {
            // Allow console.error and console.warn, but disallow console.log
            'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
            // TypeScript handles unused vars better with _ prefix convention
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                },
            ],
            // Allow explicit any in some cases (we use it for dynamic imports)
            '@typescript-eslint/no-explicit-any': 'warn',
        },
    }
)
