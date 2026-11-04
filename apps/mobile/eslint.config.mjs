import base from '../../eslint.config.js';
export default [
  ...base,
  { ignores: ['ios/**', 'android/**', '.expo/**', 'src/preview/generated.ts'] },
  { files: ['**/*.cjs'], rules: { '@typescript-eslint/no-require-imports': 'off' } },
];
