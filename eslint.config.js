import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

/**
 * Standard §4 is enforced mechanically where possible, so review time is spent
 * on logic rather than on spotting the same violations by eye.
 */
const architectureRules = {
  // Standard §4.1 — tenant scoping lives in the Prisma extension + RLS only.
  // Sprint plan §2.2 makes a manual filter an automatic PR rejection.
  'no-restricted-syntax': [
    'error',
    {
      selector: "Property[key.name='where'] > ObjectExpression > Property[key.name='tenantId']",
      message:
        'Tenant scoping is injected by the Prisma Client Extension (packages/db). Remove this manual `where: { tenantId }` — see CLAUDE.md standard #1.',
    },
    {
      selector:
        "CallExpression[callee.object.name='Math'][callee.property.name=/^(round|ceil|floor)$/]",
      message:
        'Money is integer minor units and rounds exactly once in the bill pipeline. Use the Money helper from @brewsync/shared instead of ad-hoc Math rounding.',
    },
  ],
  '@typescript-eslint/ban-ts-comment': [
    'error',
    { 'ts-ignore': 'allow-with-description', minimumDescriptionLength: 10 },
  ],
  '@typescript-eslint/no-explicit-any': 'error',
  '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
  '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
}

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/*.config.js',
      '**/*.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: architectureRules,
  },
  {
    // The extension is the one place allowed to write tenant filters — it is the
    // layer everything else delegates to.
    files: ['packages/db/src/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests deliberately reach past the extension to prove RLS holds on its own.
    files: ['**/*.test.ts', '**/tests/**'],
    rules: { 'no-restricted-syntax': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  },
  prettier
)
