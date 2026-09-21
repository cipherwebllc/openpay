'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Copy } from 'lucide-react';
import { useAccount, useReadContract } from 'wagmi';
import { erc20Abi, formatUnits, isAddress, zeroAddress, type Address } from 'viem';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { chainNameForId } from '@/lib/chains';
import { defaultDeploymentForSymbol } from '@/lib/tokens';

// 再訪時に残高カードをすぐ出すための端末ローカルの控え (公開アドレスのみ・秘密ではない)。
const STORAGE_KEY = 'openpay.agent.address';

const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });
const AgentFundFromWallet = dynamic(() => import('./AgentFundFromWallet').then((m) => m.AgentFundFromWallet), { ssr: false });

const AgentActivity = dynamic(() => import('./AgentActivity').then((m) => m.AgentActivity), { ssr: false });

export function AgentWalletCard({ c, activity }: { c: AgentPageContent['wallet']; activity: AgentPageContent['activity'] }) {
  const locale = useLocale();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const params = useSearchParams();
  const [input, setInput] = useState(() => {
    const initial = params.get('address');
    return initial && isAddress(initial) ? initial : '';
  });
  const [restored, setRestored] = useState(false);
  const [editing, setEditing] = useState(false);
  // `?address=` 付きの着地は MCP の入金リンク (wallet_init の fundingUrl) 経由 = 入金が目的なので、パネルを開いて迎える。
  const [fundOpen, setFundOpen] = useState(() => { const initial = params.get('address'); return Boolean(initial && isAddress(initial)); });
  const changeRef = useRef<HTMLButtonElement>(null);
  const [fundBusy, setFundBusy] = useState(false);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  // localStorage は SSR と初回描画に無いので mount 後に 1 回だけ読む。
  // ブラウザ API の失敗 (private mode 等) をページ描画へ波及させないための try-catch。
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && isAddress(saved)) setInput((current) => (current === '' ? saved : current));
    } catch {
      // 控えが読めなくても手入力で使える。
    }
    setRestored(true);
    function openFundFromHash() {
      if (window.location.hash === '#agent-fund') setFundOpen(true);
    }
    openFundFromHash();
    window.addEventListener('hashchange', openFundFromHash);
    return () => window.removeEventListener('hashchange', openFundFromHash);
  }, []);
  const { address: connectedAddress, isConnected } = useAccount();
  const { copy, copied, available: clipboardAvailable } = useCopyToClipboard();
  // 入金パネルは常に mount される。server と client でコピーボタンの有無が食い違う hydration エラーを避ける。
  const available = useHydrationSafeAvailable(clipboardAvailable);
  const value = input.trim();
  const address = isAddress(value) ? value : undefined;
  // アドレスが無い初期状態では入力欄を出さない: ウォレットは下の「Agent を接続」のセットアップで利用者のマシン上に
  // 作られ、Agent が返すリンク (`?address=`) を開けばここに反映される。入力欄は手入力を選んだとき (editing) と、
  // 入力が不正なとき (直せるように) だけ出す。
  const inputExpanded = editing || Boolean(value && !address);
  // 未入力でもフォームを mount しておく。zeroAddress は非表示時だけの初期値。
  // 送信中のアドレス編集が、確認済みの送り先・receipt 表示へ波及しないよう保持する。
  const [fundAddress, setFundAddress] = useState<Address>(address ?? zeroAddress);
  useEffect(() => {
    if (address && !fundBusy) setFundAddress(address);
  }, [address, fundBusy]);
  const fundVisible = fundBusy || (Boolean(address) && fundOpen);
  // 入金用の表示 (アドレス行・コピー・QR) は常に「いま上のカードに出ているアドレス」。fundAddress は送金フォームの宛先専用。
  // 送信中にアドレスを変えても QR が旧アドレスのまま残り、外部からの入金が意図しない宛先へ着く波及を断つ。
  const shownAddress = address ?? fundAddress;
  const pendingToOther = fundBusy && Boolean(address) && fundAddress.toLowerCase() !== (address ?? '').toLowerCase();
  useEffect(() => {
    if (!restored) return;
    try {
      if (address) window.localStorage.setItem(STORAGE_KEY, address);
      else if (value === '') window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // 控えの保存失敗は次回の手入力で足りる。
    }
  }, [address, value, restored]);
  const deployment = defaultDeploymentForSymbol('jpyc');
  const balance = useReadContract({
    abi: erc20Abi,
    address: deployment.address,
    chainId: deployment.chainId,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(address) },
  });
  const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-emerald-600';
  return (
    // 控えの復元 (mount 後) までは中身を出さない: 空状態 → 残高カードへの差し替わりを見せないため。
    // 高さの予約はしない (空状態と残高カードの高さは近く、予約すると空状態に大きな空白ができる)。
    <section className="min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6">
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <div hidden={!restored}>
        {!address && !inputExpanded ? (
          <div className="mt-2">
            <p className="text-sm leading-relaxed text-slate-700">{c.emptyLead}</p>
            <p className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <a href="#agent-connect" className={`font-bold text-brand underline underline-offset-2 ${focus}`}>{c.emptyConnectCta}</a>
              <button type="button" aria-expanded={false} aria-controls="agent-wallet-input" className={`text-slate-600 underline underline-offset-2 ${focus}`} onClick={() => setEditing(true)}>{c.manualEntry}</button>
            </p>
          </div>
        ) : null}
        <div id="agent-wallet-input" hidden={!inputExpanded}>
          <p className="mt-2 text-sm text-slate-700">{c.lead}</p>
          <label htmlFor="agent-wallet-address" className="mt-3 block text-sm font-medium">{c.inputLabel}</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input id="agent-wallet-address" className={`block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm ${focus}`} placeholder={c.inputPlaceholder} value={input} spellCheck={false} autoCapitalize="none" aria-invalid={Boolean(value && !address)} aria-describedby={value && !address ? 'agent-wallet-error' : undefined} onChange={(e) => { setInput(e.target.value); setEditing(true); }} />
            {isConnected && connectedAddress ? <button type="button" className={`shrink-0 rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium ${focus}`} onClick={() => {
              setInput(connectedAddress);
              setEditing(false);
              // 押したボタンごと入力欄が畳まれる。フォーカスが body に落ちないよう「変更」へ移す。
              requestAnimationFrame(() => changeRef.current?.focus());
            }}>{c.useConnected}</button> : null}
          </div>
          {value && !address ? <p id="agent-wallet-error" className="mt-2 text-xs text-red-700">{c.invalidAddress}</p> : null}
        </div>
        {address ? (
          <div className="mt-4 grid grid-cols-1 gap-4 rounded-2xl bg-slate-900 p-5 text-white sm:p-6">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
              <span className="rounded-full bg-white/10 px-3 py-1 font-mono text-slate-200">{address.slice(0, 6)}…{address.slice(-4)}</span>
              {available ? <button type="button" className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white ${focus}`} onClick={async () => { if (await copy(address)) setCopiedAddress(address); }}><Copy aria-hidden size={14} />{copied && copiedAddress === address ? c.copied : c.copyShort}</button> : null}
              <button ref={changeRef} type="button" aria-expanded={inputExpanded} aria-controls="agent-wallet-input" className={`rounded-lg px-2 py-1 text-xs text-white underline ${focus}`} onClick={() => setEditing((current) => !current)}>{c.changeAddress}</button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="min-w-0">
                <div role="status" className="text-sm text-slate-300">
                  {balance.isError ? c.balanceError : balance.data === undefined ? c.balanceLoading : (
                    <p className="break-all text-5xl font-light tracking-tight text-white sm:text-6xl">
                      {formatUnits(balance.data, deployment.decimals)}
                      <span className="ml-2 text-base font-normal text-slate-400">JPYC</span>
                    </p>
                  )}
                </div>
                <p className="mt-2 text-xs text-slate-400">{c.balanceLabel} · {chainNameForId(deployment.chainId)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <a href="#agent-connect" className={`rounded-xl border border-white/30 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 ${focus}`}>{c.connectCta}</a>
                <button type="button" aria-expanded={fundVisible} aria-controls="agent-fund" disabled={fundBusy} className={`rounded-xl bg-white px-4 py-2 text-sm font-bold text-slate-900 transition hover:bg-slate-100 disabled:opacity-50 ${focus}`} onClick={() => setFundOpen((current) => !current)}>{fundVisible ? c.closeFund : c.fundCta}</button>
              </div>
            </div>
          </div>
        ) : null}
        {/* まだ何も読み取っていない初期状態では出さない (読み取りが起きる = アドレスあり / 手入力中 のときの注記)。 */}
        {address || inputExpanded ? <p className="mt-3 text-xs leading-relaxed text-slate-500">{c.ownershipNote}</p> : null}
        {/* hidden は grid と別の要素に付け、display:grid による上書きも防ぐ。開閉・編集で子を再生成しない。 */}
        <div id="agent-fund" hidden={!fundVisible} className="mt-5 scroll-mt-24">
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-[1fr_auto]">
            <div className="min-w-0">
              <h3 className="font-bold text-slate-900">{c.fundTitle}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{c.fundBody}</p>
              <p className="mt-3 select-all break-all font-mono text-sm">{shownAddress}</p>
              {available ? <button type="button" className={`mt-3 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white ${focus}`} onClick={async () => { if (await copy(shownAddress)) setCopiedAddress(shownAddress); }}>{copied && copiedAddress === shownAddress ? c.copied : c.copyAddress}</button> : null}
            </div>
            {/* QR は直前のアドレス行と同じ情報なので a11y ツリーからは外す (掟 8)。 */}
            <div aria-hidden className="h-fit w-fit rounded-xl bg-white p-3 ring-1 ring-slate-200/70"><QRCodeSVG value={shownAddress} size={160} /></div>
            <div className="min-w-0 sm:col-span-2">
              {fundBusy ? <p className="mb-3 text-xs leading-relaxed text-slate-600">{c.fundLockedNote}</p> : null}
              {pendingToOther ? <p className="mb-3 break-all rounded-xl bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 ring-1 ring-amber-200">{c.pendingToOther} <span className="font-mono">{fundAddress}</span></p> : null}
              <AgentFundFromWallet locale={locale} c={c.fundFromWallet} agentAddress={fundAddress} onSent={() => { void balance.refetch(); setActivityRefreshKey((key) => key + 1); }} onBusyChange={setFundBusy} />
            </div>
          </div>
        </div>
        {address ? <AgentActivity address={address} locale={locale} c={activity} refreshKey={activityRefreshKey} /> : null}
      </div>
    </section>
  );
}
