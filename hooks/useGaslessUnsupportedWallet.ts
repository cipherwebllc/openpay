'use client';

// JPYC のガスレス (EIP-3009) で払えないウォレットを、署名の前に見分ける (/pay・/checkout・お店の端末で送る)。
// JPYC の transferWithAuthorization / receiveWithAuthorization は ecrecover だけで (ERC-1271 なし)、`from` が contract の口座
// (ERC-4337 のスマートアカウント・マイナウォレット等) の署名は server が recover できず、署名の後に signature_invalid で断られる。
// つないだ時点で支払うチェーンの code を読み、7702 の委任でない code なら true (lib/gaslessUnsupportedWallet.ts)。
// code の無い EOA と、7702 で委任した EOA (HashPort・MetaMask) は false。
//
// 案内を出すためだけに使う。支払いボタン・canSubmit・通常決済への切り替えの条件は変えない (掟 12)。
// 読み込み中・読めないときは false (fail-open): 判定の RPC の失敗や遅れが、いまガスレスで払える人の支払いを止めたり、
// 誤った案内を出したりするのを断つ。まだ deploy していないスマートアカウントは code が無いので見分けられず、署名の後の
// signature_invalid で同じ案内を出す (lib/relay/relayErrorMessage.ts)。
// 結果は address と chain の組に結び付ける (別のアドレス・チェーンの古い結果を返さない)。

import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import type { GaslessUnsupportedWalletPath } from '@/lib/gaslessUnsupportedWallet';

// 遅延 import は module につき 1 回 (StrictMode の二重の effect でも 1 回だけ読み込む)。
let codeModule: Promise<typeof import('@/lib/gaslessUnsupportedWallet')> | undefined;

export function useGaslessUnsupportedWallet(
  address: Address | undefined,
  chainId: number,
  enabled: boolean,
  path: GaslessUnsupportedWalletPath,
): boolean {
  const key = enabled && address ? `${chainId}:${address.toLowerCase()}` : null;
  // 払えないと分かった組 (key)。今の組と同じときだけ true を返す。
  const [unsupportedKey, setUnsupportedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!key || !address) return;
    let current = true;
    (codeModule ??= import('@/lib/gaslessUnsupportedWallet'))
      .then((m) => m.readGaslessUnsupportedWallet(chainId, address, path))
      .then((unsupported) => {
        if (current && unsupported) setUnsupportedKey(key);
      })
      // fail-open (上の頭の説明): 読めない・読み込めないときは案内を出さず、今までどおりガスレスで進める。
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [key, address, chainId, path]);
  return key !== null && unsupportedKey === key;
}
