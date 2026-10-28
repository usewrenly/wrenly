import { config } from '@repo/eslint-config/base'

export default [
  ...config,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        babelOptions: { presets: [['@babel/preset-typescript', { ignoreExtensions: true }]] },
      },
    },
    // TypeScript checks these for TS syntax, including declarations and type-only imports.
    rules: { 'no-undef': 'off', 'no-unused-vars': 'off' },
  },
  { ignores: ['dist/**', '.next/**'] },
]
