'use client';

// 受取先アドレスを接続中ウォレットで初期化するロジック (QR / レジ / Tip の 3 タブ共通)。
// 2 つの関心事を分離する:
//   - 永続 receiverSource ('auto' | 'manual'): ウォレット切替の追従可否。'auto' のみ追従する。
//   - セッション userTouchedRef (mount ごとリセット): 空欄への自動補完を「ユーザがこの入力欄に
//     触れる前」に限定する。AddressInput は毎キーストローク onChange を出すため、これが無いと
//     手動クリアした瞬間に再補完してしまい入力できなくなる。
//
// 設計意図 (要件4): ユーザが明示的に入力/選択した値は尊重し、自動補完由来の値だけウォレット
// 切替に追従させる。未接続時はチップを出さず手入力のみ。

import { useCallback, useEffect, useRef } from 'react';
import { getAddress, type Address } from 'viem';
import { useAccount } from 'wagmi';

export type ReceiverSource = 'auto' | 'manual';

export function useReceiverAutofill(opts: {
  /** 生入力値 (settings.receiver)。 */
  receiver: string;
  /** settings.receiverSource。 */
  receiverSource: ReceiverSource;
  /** 解決後アドレス (ENS/Base 名込みで各タブが算出した effectiveReceiver)。 */
  effectiveReceiver: Address | null;
  /** useLocalStorageSettings の hydrated (SSR/初期 default で保存値を上書きしないため)。 */
  hydrated: boolean;
  /** receiver と receiverSource をまとめて更新する安定 setter (useCallback 推奨)。 */
  setReceiver: (value: string, source: ReceiverSource) => void;
}) {
  const { receiver, receiverSource, effectiveReceiver, hydrated, setReceiver } =
    opts;
  const { address, isConnected } = useAccount();
  const connected: Address | null =
    isConnected && address ? getAddress(address) : null;

  // mount からこの receiver 欄をユーザが触ったか (空欄への自動補完を初回限定する)。
  const userTouchedRef = useRef(false);
  // 直近に自動補完したアドレス (切替追従の冪等性確保 = 無限ループ防止)。
  const lastAutoRef = useRef<string | null>(null);

  // (1) 空欄 + 接続あり + 未タッチ + hydrated → 接続アドレスを初期補完 (source='auto')。
  useEffect(() => {
    if (!hydrated || userTouchedRef.current) return;
    if (receiver.trim() !== '') return;
    if (!connected) return;
    lastAutoRef.current = connected;
    setReceiver(connected, 'auto');
  }, [hydrated, receiver, connected, setReceiver]);

  // 前回 (2) を評価したときの接続アドレス (undefined = 読み込み後まだ評価していない)。
  const seenConnectedRef = useRef<Address | null | undefined>(undefined);

  // (2) ウォレット切替: source==='auto' のときのみ新アドレスへ追従。manual / 手入力は据置。
  // 追従するのは読み込み直後と、このタブの接続アドレスが変わったときだけ。受取先・由来だけが変わったとき (別のタブで
  // 「接続中のウォレットを使う」を選んだ設定の取り込み) は追従しない: 別のウォレットに接続しているタブが、取り込んだ
  // 受取先を自分のウォレットに置き換えて保存し、別のタブの変更を消してしまうため (hooks/useLocalStorageSettings)。
  useEffect(() => {
    if (!hydrated) return;
    const seen = seenConnectedRef.current;
    seenConnectedRef.current = connected;
    // 切断したら追従の基準を消す: 同じウォレットへの再接続も「接続アドレスが変わった」として追従する (取り込んだ別の
    // タブの受取先のまま、再接続したウォレットではなく別のウォレット宛ての QR を出し続けないため)。
    if (!connected) lastAutoRef.current = null;
    if (receiverSource !== 'auto') return;
    if (!connected || connected === lastAutoRef.current) return;
    if (seen === connected) {
      // 取り込んだ受取先をそのまま使う。以後はここを基準に、接続アドレスが変わったときだけ追従する。
      lastAutoRef.current = connected;
      return;
    }
    // mount 時に既に receiver が接続アドレスと一致しているなら no-op (冗長な書込を避ける)。
    // 実際のアドレス変化 (= ウォレット切替) のときだけ setReceiver する。
    if (receiver.toLowerCase() === connected.toLowerCase()) {
      lastAutoRef.current = connected;
      return;
    }
    lastAutoRef.current = connected;
    setReceiver(connected, 'auto');
  }, [hydrated, receiverSource, connected, receiver, setReceiver]);

  // 「接続中のウォレットを使う」ボタン: 明示的に接続アドレスを流し込み source='auto'
  // (= 以後の切替に追従)。ユーザの「接続を使う」意思なので userTouched は立てない。
  const useConnectedWallet = useCallback(() => {
    if (!connected) return;
    lastAutoRef.current = connected;
    setReceiver(connected, 'auto');
  }, [connected, setReceiver]);

  // AddressInput onChange ラッパ: ユーザ手入力は以後の自動補完を止め source='manual'。
  const handleManualChange = useCallback(
    (value: string) => {
      userTouchedRef.current = true;
      setReceiver(value, 'manual');
    },
    [setReceiver],
  );

  // 一致判定は解決後アドレスで比較 (ENS/Base 名指定でも正しく判定)。
  const matchesConnected =
    connected !== null &&
    effectiveReceiver !== null &&
    getAddress(effectiveReceiver) === connected;

  return {
    connected,
    useConnectedWallet,
    handleManualChange,
    matchesConnected,
    // チップ表示: 接続済み かつ まだ受取先が接続アドレスと一致していないとき。
    canUseConnected: connected !== null && !matchesConnected,
  };
}
