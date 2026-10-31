import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'legacy/**', 'node_modules/**', 'tools/golden/.diff/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'tools/**/*.ts', 'api/**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    // the UI layer carried over from the original single-file game (plain JS for now)
    files: ['src/ui/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { sourceType: 'module', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': 'off', 'no-empty': 'off', 'no-cond-assign': 'off', 'no-useless-escape': 'off' },
  },
  {
    // the engine, bots and coach must not touch the DOM: they also run in a Web Worker and in Node
    files: ['src/engine/**/*.ts', 'src/ai/**/*.ts', 'src/coach/**/*.ts', 'src/worker/**/*.ts', 'src/sim/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', 'document', 'window', 'localStorage', 'location'] },
  },
  {
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
);
