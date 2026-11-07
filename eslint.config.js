// ESLint flat config (ESLint 10). TypeScript + TSX for src/** and tests/**.
// Globals (browser, node, Workers) come from the TypeScript lib/types config: typescript-eslint's
// recommended set turns off `no-undef` for TS files because the type checker already covers it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'artifacts/**', 'playwright-report/**', 'test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Filename/text sanitizers intentionally match control characters (e.g. /[\x00-\x1f]/).
      'no-control-regex': 'warn',
      // Flags defensive initializers like `let ok = false; try { ok = await probe() } catch { ok = false }`.
      'no-useless-assignment': 'warn',
    },
  },
);
