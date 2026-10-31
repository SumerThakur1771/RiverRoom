import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'legacy/**', 'node_modules/**', 'tools/golden/.diff/**'] },
  {
    files: ['src/**/*.ts', 'test/**/*.ts', 'tools/**/*.ts'],
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
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: { 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
);
