'use client';

// 払う側 (/pay・/checkout) の通常決済の送金に付ける会計の印 (K4b)。その端末だけの試しのスイッチ (lib/stdBillMarkTrial.ts) が
// ON のときだけ動く。OFF (既定・ほかの全員) なら何もしない (URL の `bk` も読まず、印の chunk も読まない)。
//
// 印 = lib/relay/billKeySalt.ts の billKeyStdMark(URL の `bk`) の 32 byte。お店の端末の照合 (lib/qrSaleHistory.ts の
// stdTransferCalldata) と同じ関数。通常決済の hook (hooks/useStandardPayment.ts) が、受取先への ERC-20 の
// transfer(受取先, 額) の calldata の後ろに足す (viem の writeContract の dataSuffix)。ERC-20 は余った calldata を読まないので、
// 送金の宛先・額・本数は変わらない。
//
// 時機 (Fable の K-1): 印は mount の後 (と URL が変わった後) の effect で計算して ref に置く (state にしない = 描き直さない)。
// 押した瞬間は、その ref を同期で読むだけ: スイッチが ON のままで、今の URL の `bk` が ref の `bk` と同じときだけ印を返す。
// `bk` が無い・違う・形が違う・計算中・chunk を読めなかったときは undefined (印なし) を返し、呼ぶ側は今までどおりの送金を
// その場で送る。押した後に await を挟まない (待つ間の二度押しで二重払いの窓を作らない)。
//
// 対象の条件 (eligible) は呼ぶ側が決める (JPYC・金額あり・分配なし・束縛や遠隔の注文でない)。経路が通常決済かどうかは、呼ぶ側が
// 通常決済の分岐の中でだけ印を取ることで決まる (ガスレスの画面のまま準備しておき、通常決済へ切り替えた後の送金にも付ける)。
// 印は送金の calldata にだけ載る: 保存する intent・contextKey・履歴・控え・ログには入れない (呼ぶ側も通常決済の hook も渡さない)。
//
// 付帯の処理 (掟 13): 印の chunk の読み込みの失敗は、印なしのまま払える (支払いが本体・印は付帯)。

import { useEffect, useRef } from 'react';
import type { Hex } from 'viem';
import { readBillKeyParam } from '@/lib/url/billKey';
import { isStdBillMarkTrialOn } from '@/lib/stdBillMarkTrial';

/**
 * 通常決済の送金に付ける印を、押した瞬間に同期で返す関数を返す (印を付けないときは undefined)。
 * eligible = この画面の会計が印の対象か。urlKey = URL が変わったら印を作り直すための値 (画面の params の object)。
 */
export function useStdBillMark(eligible: boolean, urlKey: unknown): () => Hex | undefined {
  const preparedRef = useRef<{ billKey: string; mark: Hex } | null>(null);
  useEffect(() => {
    if (!eligible || !isStdBillMarkTrialOn()) return;
    const billKey = readBillKeyParam();
    if (!billKey) return;
    let active = true;
    import('@/lib/relay/billKeySalt')
      .then(({ billKeyStdMark }) => {
        const mark = billKeyStdMark(billKey);
        if (active && mark) preparedRef.current = { billKey, mark };
      })
      // 断つ波及: 印の chunk を読めない (回線・deploy の切り替わり) ことで、支払いが止まること (印なしのまま払う)。
      .catch(() => {});
    // URL が変わった・画面を離れた: 前の URL の印 (計算中のものも) を使わない。
    return () => {
      active = false;
      preparedRef.current = null;
    };
  }, [eligible, urlKey]);

  return () => {
    const prepared = preparedRef.current;
    if (!eligible || !prepared || !isStdBillMarkTrialOn()) return undefined;
    return readBillKeyParam() === prepared.billKey ? prepared.mark : undefined;
  };
}
