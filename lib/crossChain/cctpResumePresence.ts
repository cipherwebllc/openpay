// 親フォーム (PaymentForm / TipForm) が、遅延ロードの CrossChainHint より先に、この請求の宛先・受取人に
// CCTP の中断記録がこのブラウザに残っているかを同期で判定する (第 9 回レビュー A-1)。残っていれば、子が
// 走査して committed を報告するまで直接払いを閉じる。First Load JS に cross-chain の実装を載せないよう
// resumeStore は import せず、key の形 (resumeStore の keyString: `cctp-v2:送金元:宛先:account:受取人:額:利用料`
// を小文字化) だけを読む。形のずれは tests/lib/cctpResumePresence.test.ts が実物の保存で検出する。
// 送金元・金額・中身は見ない (広めに当てても、子の報告までの数フレームを待つだけで済む)。

const CCTP_RESUME_PREFIX = 'openpay.xchain.resume.cctp-v2:';

export function hasSavedCctpResume(args: {
  account: string;
  destChainId: number;
  recipient: string;
}): boolean {
  const dest = String(args.destChainId);
  const account = args.account.toLowerCase();
  const recipient = args.recipient.toLowerCase();
  try {
    if (typeof window === 'undefined') return false;
    const store = window.localStorage;
    for (let i = 0; i < store.length; i++) {
      const name = store.key(i);
      if (!name?.startsWith(CCTP_RESUME_PREFIX)) continue;
      const [, keyDest, keyAccount, keyRecipient] = name.slice(CCTP_RESUME_PREFIX.length).split(':');
      if (keyDest === dest && keyAccount === account && keyRecipient === recipient) return true;
    }
    return false;
  } catch {
    // storage を読めない環境で「記録なし」と決めつけると、burn 済みの請求を直接払いで二重に払える窓が
    // 開く。判定できないときは子の走査報告を待つ側に倒す (待つのは子のロードと 1 回の走査だけ)。
    return true;
  }
}
