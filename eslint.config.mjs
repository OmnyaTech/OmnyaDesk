import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/target/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/operator/**/*.{jsx,js}', 'scripts/smoke-desktop-webview.mjs'],
    languageOptions: { globals: { ...globals.browser }, parserOptions: { ecmaFeatures: { jsx: true } } },
  },
  {
    files: ['**/*.{mjs,js,ts}'],
    languageOptions: { globals: { ...globals.node, ...globals.es2022 } },
  },
);
