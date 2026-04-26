// 名前 (.eth / .base.eth) かどうかの軽量判定。viem の ENS コードを引き込まない。
// resolveAddress 本体は dynamic import で遅延ロードされるため、判定だけは
// 静的 import 可能なこのファイルに切り出す。
const ENS_PATTERN = /\.eth$/i;
const BASENAMES_PATTERN = /\.base\.eth$/i;

export function isLikelyName(input: string): boolean {
  const trimmed = input.trim();
  return ENS_PATTERN.test(trimmed) || BASENAMES_PATTERN.test(trimmed);
}
