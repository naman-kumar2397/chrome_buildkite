import js from '@eslint/js';
import globals from 'globals';

const chromeGlobals = { ...globals.browser, ...globals.webextensions, chrome: 'readonly' };

export default [
  { ignores: ['node_modules/**', 'store/**', 'dist/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: chromeGlobals,
    },
    rules: {
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'off',
      'object-shorthand': 'error',
    },
  },
  {
    // Node-side tooling and tests
    files: ['test/**/*.js', 'scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
];
