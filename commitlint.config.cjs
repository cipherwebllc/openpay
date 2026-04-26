// Conventional Commits の最小設定。type-enum は OpenPay の運用に合わせて拡張。
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'chore',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'revert',
        'style',
      ],
    ],
    // 日本語サブジェクトを許可するため case 制約を緩める
    'subject-case': [0],
    'subject-full-stop': [2, 'never', '.'],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [0],
  },
};
