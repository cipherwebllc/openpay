// 生成した秘密鍵を stdout に出さず、0600 のファイルへ書き出す共通ヘルパー。
//
// なぜ: stdout はターミナルのスクロールバック・CI ログ・スクショ・チャット貼り付けに
// 残る。鍵の露出経路をファイル 1 本 (所有者のみ読める) に絞り、他の出力面へ波及させない。
//
// 使い方: const { path } = writeGeneratedKey(privateKey, 'relayer');
//   - 出力先は env KEY_OUT、未設定なら ./<prefix>-key.<timestamp>.txt
//   - 既存ファイルは **上書きしない** (wx flag → 既存鍵の消失を防ぐ)

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function generatedKeyPath(prefix, now = new Date()) {
  const envPath = process.env.KEY_OUT;
  if (envPath && envPath.length > 0) return resolve(envPath);
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), `${prefix}-key.${stamp}.txt`);
}

export function writeGeneratedKey(privateKey, prefix, extra = {}) {
  const path = generatedKeyPath(prefix);
  const body =
    Object.entries(extra)
      .map(([k, v]) => `${k}=${v}`)
      .concat(`PRIVATE_KEY=${privateKey}`)
      .join('\n') + '\n';
  try {
    writeFileSync(path, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      throw new Error(
        `${path} は既に存在します。既存の鍵を上書きしないため中止しました (KEY_OUT で別のパスを指定してください)。`,
      );
    }
    throw err;
  }
  return { path };
}
