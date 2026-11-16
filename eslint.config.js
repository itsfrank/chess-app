import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', '.data/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  { files: ['server/**', '*.config.*'], languageOptions: { globals: globals.node } },
);
