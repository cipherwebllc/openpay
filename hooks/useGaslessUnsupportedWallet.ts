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
//
// 結果は「今の読み取り」だけに結び付ける: 入力 (address・chain・enabled) が変わるたびに前の結果を捨てる (同じ組に戻っても、
// 読み直すまでは false)。前の読み取りの遅れた結果・unmount の後の結果は反映しない。

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
  // アドレスは小文字にそろえてから使う (読み取りの入力も key と同じにする: 大文字・小文字だけが変わったときに読み直して、
  // 読み込み中に前の結果を返す順を作らない)。
  const normalized = enabled && address ? (address.toLowerCase() as Address) : undefined;
  const key = normalized ? `${chainId}:${normalized}` : null;
  // 今の入力 (key) の読み取りの結果。入力が変わったら、描画の中で前の結果を捨てる (React の「props が変わったら state を
  // 合わせる」形・effect の中で同期に setState しない)。A → B → A と戻っても、A の前の結果は残らない。
  const [read, setRead] = useState({ key, unsupported: false });
  if (read.key !== key) setRead({ key, unsupported: false });
  useEffect(() => {
    if (!key || !normalized) return;
    let current = true;
    (codeModule ??= import('@/lib/gaslessUnsupportedWallet'))
      .then((m) => m.readGaslessUnsupportedWallet(chainId, normalized, path))
      .then(
        (unsupported) => {
          if (current) setRead({ key, unsupported });
        },
        // fail-open (上の頭の説明): 読めない・読み込めないときは案内を出さず、今までどおりガスレスで進める。
        () => {
          if (current) setRead({ key, unsupported: false });
        },
      );
    return () => {
      current = false;
    };
  }, [key, normalized, chainId, path]);
  return read.key === key && read.unsupported;
}
