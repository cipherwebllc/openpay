#!/usr/bin/env bash
# .env.local の単一 backup を取って vercel CLI による上書き事故から守る。
#
# 設計判断 (なぜ単一 backup か):
# - 旧 README は `cp .env.local .env.local.predeploy-backup-$(date)` を都度実行する
#   方針で、毎 deploy ごとに 5KB の backup ファイルが残り、結果的に 10+ 個累積した
#   (`.env.local.backup-*`, `.env.local.bak.*`, `.env.local.predeploy-backup-*` の
#    3 種類の命名が混在)。
# - 切り戻し時に必要なのは「直前の good state」だけで、それ以前の履歴は git の env 注入
#   元 (Vercel Dashboard / 1Password 等) で復元できる。
# - 単一 backup `.env.local.backup` を毎回上書きする方が運用上シンプルかつ事故が少ない。
#
# 使い方:
#   ./scripts/predeploy-backup.sh                     # backup を取って md5 表示
#   ./scripts/predeploy-backup.sh --verify-after      # vercel deploy 後の md5 整合性確認
#                                                       (一致しなければ backup から復元)
#
# `.env.local.backup` は .gitignore の `.env.local.*` パターンで除外済。

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".env.local"
BACKUP_FILE=".env.local.backup"

# macOS の md5 と GNU の md5sum を両対応する。
md5_of() {
  if [ ! -f "$1" ]; then
    echo "<missing>"
    return
  fi
  if command -v md5 > /dev/null; then
    md5 -q "$1"
  else
    md5sum "$1" | awk '{print $1}'
  fi
}

require_env_file() {
  if [ ! -f "$ENV_FILE" ]; then
    echo "❌ $ENV_FILE が存在しません。Vercel Dashboard から env を取得して配置してください。" >&2
    exit 1
  fi
}

backup() {
  require_env_file
  local current_md5
  current_md5="$(md5_of "$ENV_FILE")"

  if [ -f "$BACKUP_FILE" ]; then
    local backup_md5
    backup_md5="$(md5_of "$BACKUP_FILE")"
    if [ "$current_md5" = "$backup_md5" ]; then
      echo "✓ 現 $ENV_FILE と $BACKUP_FILE は同一 (md5: $current_md5)。backup は skip。"
      return
    fi
    echo "⚠ 既存 $BACKUP_FILE と md5 が異なるため上書きします。"
    echo "  旧 backup md5: $backup_md5"
    echo "  新 backup md5: $current_md5"
  fi

  cp "$ENV_FILE" "$BACKUP_FILE"
  echo "✓ backup 作成: $BACKUP_FILE (md5: $current_md5)"
  echo ""
  echo "次のステップ:"
  echo "  1. vercel --prod --yes"
  echo "  2. ./scripts/predeploy-backup.sh --verify-after  # deploy 後の整合性確認"
}

verify_after() {
  require_env_file
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "❌ $BACKUP_FILE が存在しません。先に backup なしで verify はできません。" >&2
    exit 1
  fi
  local current_md5 backup_md5
  current_md5="$(md5_of "$ENV_FILE")"
  backup_md5="$(md5_of "$BACKUP_FILE")"

  if [ "$current_md5" = "$backup_md5" ]; then
    echo "✓ $ENV_FILE は deploy 前と一致 (md5: $current_md5)。vercel CLI による上書きは発生していません。"
    exit 0
  fi

  echo "⚠ $ENV_FILE が deploy 後に変更されています:"
  echo "  deploy 前 md5: $backup_md5"
  echo "  現在 md5:     $current_md5"
  echo ""
  echo "vercel CLI が .env.local を上書きした可能性があります。"
  echo "backup から復元するには:"
  echo "  cp $BACKUP_FILE $ENV_FILE"
  echo ""
  echo "復元前に diff を確認:"
  echo "  diff $BACKUP_FILE $ENV_FILE"
  exit 2
}

case "${1:-}" in
  --verify-after)
    verify_after
    ;;
  "")
    backup
    ;;
  *)
    echo "Usage: $0 [--verify-after]" >&2
    exit 1
    ;;
esac
