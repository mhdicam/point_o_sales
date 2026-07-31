/** Sprint plan §2.1 — Conventional Commits feed changelog + versioning later. */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'test', 'chore', 'docs', 'perf', 'build', 'ci', 'revert'],
    ],
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
  },
}
