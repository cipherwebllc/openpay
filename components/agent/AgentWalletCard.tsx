'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';
import { Copy } from 'lucide-react';
import { useAccount, useReadContract } from 'wagmi';
import { erc20Abi, formatUnits, isAddress, zeroAddress, type Address } from 'viem';
import { AGENT_ADDRESS_STORAGE_KEY, setAgentHasWallet } from '@/hooks/useAgentView';
import { useCopyToClipboard, useHydrationSafeAvailable } from '@/hooks/useCopyToClipboard';
import type { AgentPageContent } from '@/lib/agentPage';
import { AGENT_WALLET_RESERVE } from '@/lib/agentLayout';
import { chainNameForId } from '@/lib/chains';
import { env } from '@/lib/env';
import { defaultDeploymentForSymbol } from '@/lib/tokens';
import { AGENT_COLORS, AGENT_COLOR_DOT, AGENT_COLOR_SURFACE, AGENT_ICONS, addressHues, isAgentColor, isAgentIcon, type AgentColor, type AgentIcon } from '@/lib/agentProfile';
import { AgentStoreLink } from './AgentStoreLink';

const STORAGE_KEY = AGENT_ADDRESS_STORAGE_KEY;
// 最近表示した Wallet (公開アドレスと、利用者が自分で選んだ見た目 = 名前・色・アイコンだけ)。Wallet の種類 (Kova 等) を
// アドレスから推測しない — 見た目は利用者が選んだときだけ出す。ここでの切替は「表示する Wallet」だけで、
// Agent の署名方式は変わらない (切替は設定生成か Agent への依頼で行う)。
const RECENT_KEY = 'openpay.agent.recent';
const RECENT_MAX = 5;
const LABEL_MAX = 20;
type RecentWallet = { address: string; label?: string; color?: AgentColor; icon?: AgentIcon };
type WalletLook = Omit<RecentWallet, 'address'>;
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function readRecent(): RecentWallet[] {
  // ブラウザ API の失敗や壊れた控えをページ描画へ波及させない (壊れた要素は捨てる)。
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const { address, label, color, icon } = item as { address?: unknown; label?: unknown; color?: unknown; icon?: unknown };
      if (typeof address !== 'string' || !isAddress(address)) return [];
      const name = typeof label === 'string' ? label.trim().slice(0, LABEL_MAX) : '';
      // 知らない色・アイコン (古い版や手で書き換えた控え) は捨てて既定の見た目にする。
      return [{ address, ...(name ? { label: name } : {}), ...(isAgentColor(color) ? { color } : {}), ...(isAgentIcon(icon) ? { icon } : {}) }];
    }).slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

function writeRecent(list: RecentWallet[]): void {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // 控えの保存失敗は一覧が出ないだけで、表示中の Wallet には波及しない。
  }
}

// アイコンがあればアイコン、なければアドレス由来の 2 色の丸。隣に名前かアドレスの文字があるので読み上げない。
function AgentAvatar({ address, icon, className }: { address: string; icon?: AgentIcon; className: string }) {
  if (icon) return <span aria-hidden className={`inline-flex shrink-0 items-center justify-center rounded-full bg-white/90 leading-none ${className}`}>{icon}</span>;
  const [from, to] = addressHues(address);
  return <span aria-hidden className={`inline-block shrink-0 rounded-full ${className}`} style={{ background: `linear-gradient(135deg, hsl(${from} 70% 55%), hsl(${to} 70% 40%))` }} />;
}

const QRCodeSVG = dynamic(() => import('qrcode.react').then((m) => m.QRCodeSVG), { ssr: false });
const AgentFundFromWallet = dynamic(() => import('./AgentFundFromWallet').then((m) => m.AgentFundFromWallet), { ssr: false });

const AgentActivity = dynamic(() => import('./AgentActivity').then((m) => m.AgentActivity), { ssr: false });

const AgentPurchases = env.enableAgentPurchases
  ? dynamic(() => import('./AgentPurchases').then((m) => m.AgentPurchases), { ssr: false })
  : null;

export function AgentWalletCard({ c, activity, purchases }: { c: AgentPageContent['wallet']; activity: AgentPageContent['activity']; purchases: AgentPageContent['purchases'] }) {
  const locale = useLocale();
  const [copiedAddress, setCopiedAddress] = useState<string | null>(null);
  const params = useSearchParams();
  const [linkedAddress] = useState(() => {
    const initial = params.get('address');
    return initial && isAddress(initial) ? initial : '';
  });
  const [input, setInput] = useState('');
  const [pendingLinkedAddress, setPendingLinkedAddress] = useState<string | null>(null);
  const [restored, setRestored] = useState(false);
  const [editing, setEditing] = useState(false);
  // `?address=` 付きの着地は MCP の入金リンク (wallet_init の fundingUrl) 経由 = 入金が目的なので、パネルを開いて迎える。
  const [fundOpen, setFundOpen] = useState(() => { const initial = params.get('address'); return Boolean(initial && isAddress(initial)); });
  const changeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [fundBusy, setFundBusy] = useState(false);
  const [activityRefreshKey, setActivityRefreshKey] = useState(0);
  const [recent, setRecent] = useState<RecentWallet[]>([]);
  // localStorage は SSR と初回描画に無いので mount 後に 1 回だけ読む。
  // ブラウザ API の失敗 (private mode 等) をページ描画へ波及させないための try-catch。
  useEffect(() => {
    let initial = linkedAddress;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved && isAddress(saved)) {
        initial = saved;
        // 外部リンクが端末の控えと送金先を無断で置き換える波及を、確認まで止める。
        if (linkedAddress && linkedAddress.toLowerCase() !== saved.toLowerCase()) setPendingLinkedAddress(linkedAddress);
      }
    } catch {
      // 控えが読めなくても手入力で使える。
    }
    setInput(initial);
    setRecent(readRecent());
    setRestored(true);
    // ページの並び (Wallet を先頭に出すか) を確定する。初回は復元した控え・リンクのアドレスの有無で決める。
    setAgentHasWallet(Boolean(initial));
    function openFundFromHash() {
      if (window.location.hash === '#agent-fund') setFundOpen(true);
    }
    // 紐づけリンク (#proof=) も ?address= を持つが、目的は購入履歴なので入金パネルは開かない。
    if (window.location.hash.startsWith('#proof=')) setFundOpen(false);
    openFundFromHash();
    window.addEventListener('hashchange', openFundFromHash);
    return () => window.removeEventListener('hashchange', openFundFromHash);
  }, [linkedAddress]);
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
  const fundVisible = fundBusy || (!pendingLinkedAddress && Boolean(address) && fundOpen);
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
  // 手入力・最近の Wallet から表示したときも Wallet を先頭へ。逆向き (消したら初回の並びへ戻す) はしない:
  // 「変更」で打ち直している途中に節ごと入れ替わると、入力中の欄が画面外へ飛ぶ。
  useEffect(() => {
    if (restored && address) setAgentHasWallet(true);
  }, [address, restored]);
  useEffect(() => {
    if (!restored || !address) return;
    setRecent((current) => {
      const existing = current.find((item) => sameAddress(item.address, address));
      const next = [existing ? { ...existing, address } : { address }, ...current.filter((item) => !sameAddress(item.address, address))].slice(0, RECENT_MAX);
      writeRecent(next);
      return next;
    });
  }, [address, restored]);
  const currentLook: WalletLook = (address ? recent.find((item) => sameAddress(item.address, address)) : undefined) ?? {};
  const currentLabel = currentLook.label ?? '';
  const otherRecent = recent.filter((item) => !address || !sameAddress(item.address, address));
  function updateCurrent(patch: WalletLook) {
    if (!address) return;
    setRecent((current) => {
      const next = current.map((item) => {
        if (!sameAddress(item.address, address)) return item;
        const merged = { ...item, ...patch };
        // 空の名前・未選択は項目ごと消す (控えに空文字や undefined を残さない)。
        return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined && value !== '')) as RecentWallet;
      });
      writeRecent(next);
      return next;
    });
  }
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
    // 高さは再訪のときだけ残高カードぶんを予約する (lib/agentLayout.ts)。
    <section className={`min-w-0 rounded-2xl bg-white p-5 shadow-card ring-1 ring-slate-200/70 sm:p-6 ${restored ? '' : AGENT_WALLET_RESERVE}`}>
      <h2 className="text-xl font-bold text-slate-900">{c.title}</h2>
      <div hidden={!restored}>
        {pendingLinkedAddress ? <div className="mt-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <p id="agent-wallet-link-confirm" className="break-all">{c.linkedAddressConfirm.replace('{address}', pendingLinkedAddress)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" aria-describedby="agent-wallet-link-confirm" className={`min-h-11 rounded-xl bg-white px-4 py-2 font-medium ${focus}`} onClick={() => {
              setInput(pendingLinkedAddress);
              setPendingLinkedAddress(null);
              requestAnimationFrame(() => changeRef.current?.focus());
            }}>{c.useLinkedAddress}</button>
            <button type="button" className={`min-h-11 rounded-xl bg-white px-4 py-2 font-medium ${focus}`} onClick={() => {
              setPendingLinkedAddress(null);
              setFundOpen(false);
              requestAnimationFrame(() => changeRef.current?.focus());
            }}>{c.keepSavedAddress}</button>
          </div>
        </div> : null}
        {!address && !inputExpanded ? (
          <div className="mt-2">
            <p className="text-sm leading-relaxed text-slate-700">{c.emptyLead}</p>
            <p className="mt-3 text-sm">
              <button type="button" aria-expanded={false} aria-controls="agent-wallet-input" className={`-my-1.5 py-1.5 text-slate-600 underline underline-offset-2 ${focus}`} onClick={() => {
                setEditing(true);
                // 押したボタン自身が消える。フォーカスが body に落ちないよう、開いた入力欄へ移す (すぐ打てる)。
                requestAnimationFrame(() => inputRef.current?.focus());
              }}>{c.manualEntry}</button>
            </p>
          </div>
        ) : null}
        <div id="agent-wallet-input" hidden={!inputExpanded}>
          <p className="mt-2 text-sm text-slate-700">{c.lead}</p>
          <label htmlFor="agent-wallet-address" className="mt-3 block text-sm font-medium">{c.inputLabel}</label>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <input ref={inputRef} id="agent-wallet-address" className={`block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm ${focus}`} placeholder={c.inputPlaceholder} value={input} spellCheck={false} autoCapitalize="none" aria-invalid={Boolean(value && !address)} aria-describedby={value && !address ? 'agent-wallet-error' : undefined} onChange={(e) => {
              const next = e.target.value;
              const valid = isAddress(next.trim());
              setInput(next);
              // 有効なアドレスになった瞬間に畳む (貼り付けが大半): 同じアドレスが入力欄・チップ・入金欄に並ぶのを避ける。
              // blur で畳むとカードのずれが進行中のクリックと重なり、入力欄から直接押した「入金する」等が空振りする。
              // 入力が変わる瞬間はクリックと重ならない。不正な間は直せるよう開いたまま。「変更」でまた開ける。
              setEditing(!valid);
              // 畳むとフォーカス中の入力欄が消える。body に落とさず「変更」へ移す (useConnected と同じ扱い)。
              if (valid) requestAnimationFrame(() => changeRef.current?.focus());
            }} />
            {isConnected && connectedAddress ? <button type="button" className={`shrink-0 rounded-xl bg-slate-100 px-4 py-2 text-sm font-medium ${focus}`} onClick={() => {
              setInput(connectedAddress);
              setEditing(false);
              // 押したボタンごと入力欄が畳まれる。フォーカスが body に落ちないよう「変更」へ移す。
              requestAnimationFrame(() => changeRef.current?.focus());
            }}>{c.useConnected}</button> : null}
          </div>
          {value && !address ? <p id="agent-wallet-error" className="mt-2 text-xs text-red-700">{c.invalidAddress}</p> : null}
          {otherRecent.length > 0 ? <div className="mt-4">
            <p className="text-sm font-medium text-slate-700">{c.recentTitle}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {otherRecent.map((item) => <li key={item.address.toLowerCase()}>
                <button type="button" className={`min-h-11 rounded-xl bg-slate-100 px-3 py-2 text-left text-xs ${focus}`} onClick={() => {
                  setInput(item.address);
                  setEditing(false);
                  // 押したボタンごと入力欄が畳まれる。フォーカスが body に落ちないよう「変更」へ移す。
                  requestAnimationFrame(() => changeRef.current?.focus());
                }}><span className="inline-flex items-center gap-2"><AgentAvatar address={item.address} icon={item.icon} className="h-5 w-5 text-xs" /><span>{item.label ? <span className="font-bold">{item.label} </span> : null}<span className="font-mono">{item.address.slice(0, 6)}…{item.address.slice(-4)}</span></span></span></button>
              </li>)}
            </ul>
          </div> : null}
          {/* 見た目は切替 (アドレス・最近の Wallet) の後ろ。表示中の Wallet にだけ効く。 */}
          {/* 区切り線は外側の div に引く (fieldset の枠に引くと legend が線の上に載る)。 */}
          {address ? <div className="mt-5 border-t border-slate-200 pt-4"><fieldset className="min-w-0">
            <legend className="text-sm font-medium">{c.lookTitle}</legend>
            <label htmlFor="agent-wallet-label" className="mt-2 block text-xs text-slate-600">{c.nameLabel}</label>
            <input id="agent-wallet-label" className={`mt-1 block w-full min-w-0 rounded-xl border border-slate-300 px-3 py-2 text-sm sm:max-w-xs ${focus}`} placeholder={c.labelPlaceholder} maxLength={LABEL_MAX} value={currentLabel} onChange={(e) => updateCurrent({ label: e.target.value.slice(0, LABEL_MAX) })} />
            {/* 色・アイコンは名前つきの選択肢 (見本だけのボタンに名前を後付けしない・掟 8)。選んだ瞬間に上の残高の面へ反映される。 */}
            <fieldset className="mt-3 min-w-0">
              <legend className="text-xs text-slate-600">{c.colorLabel}</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {AGENT_COLORS.map((color) => <label key={color} className="relative cursor-pointer">
                  <input type="radio" name="agent-wallet-color" value={color} className="peer sr-only" checked={(currentLook.color ?? 'ink') === color} onChange={() => updateCurrent({ color: color === 'ink' ? undefined : color })} />
                  <span className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1.5 text-xs text-slate-700 ring-slate-900 peer-checked:bg-white peer-checked:font-bold peer-checked:ring-2 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-600"><span aria-hidden className={`h-3 w-3 rounded-full ${AGENT_COLOR_DOT[color]}`} />{c.colorNames[color]}</span>
                </label>)}
              </div>
            </fieldset>
            <fieldset className="mt-3 min-w-0">
              <legend className="text-xs text-slate-600">{c.iconLabel}</legend>
              <div className="mt-1 flex flex-wrap gap-2">
                {([undefined, ...AGENT_ICONS] as const).map((icon) => <label key={icon ?? 'none'} className="relative cursor-pointer">
                  <input type="radio" name="agent-wallet-icon" value={icon ?? ''} className="peer sr-only" checked={currentLook.icon === icon} onChange={() => updateCurrent({ icon })} />
                  <span className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-full bg-slate-100 px-2.5 py-1.5 text-sm text-slate-700 ring-slate-900 peer-checked:bg-white peer-checked:ring-2 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-600">{icon ?? <span className="text-xs">{c.iconNone}</span>}</span>
                </label>)}
              </div>
            </fieldset>
          </fieldset></div> : null}
        </div>
        {address ? (
          // 面の色は利用者が選んだもの (既定は墨)。文字は白の濃淡だけにして、どの色でもコントラストを保つ。
          <div className={`mt-4 grid grid-cols-1 gap-4 rounded-2xl p-5 text-white sm:p-6 ${AGENT_COLOR_SURFACE[currentLook.color ?? 'ink']}`}>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2 text-xs">
              <span className="mr-auto inline-flex min-w-0 items-center gap-2.5">
                <AgentAvatar address={address} icon={currentLook.icon} className="h-9 w-9 text-lg" />
                <span className="min-w-0">
                  {currentLabel ? <span className="block truncate text-sm font-bold text-white">{currentLabel}</span> : null}
                  <span className="block font-mono text-white/75">{address.slice(0, 6)}…{address.slice(-4)}</span>
                </span>
              </span>
              {available ? <button type="button" className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-white ${focus}`} onClick={async () => { if (await copy(address)) setCopiedAddress(address); }}><Copy aria-hidden size={14} />{copied && copiedAddress === address ? c.copied : c.copyShort}</button> : null}
              <button ref={changeRef} type="button" aria-expanded={inputExpanded} aria-controls="agent-wallet-input" className={`rounded-lg px-2 py-1 text-xs text-white underline ${focus}`} onClick={() => setEditing((current) => !current)}>{c.changeAddress}</button>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <div className="min-w-0">
                <div role="status" className="text-sm text-white/80">
                  {balance.isError ? c.balanceError : balance.data === undefined ? c.balanceLoading : (
                    <p className="break-all text-5xl font-light tracking-tight text-white sm:text-6xl">
                      {formatUnits(balance.data, deployment.decimals)}
                      <span className="ml-2 text-base font-normal text-white/70">JPYC</span>
                    </p>
                  )}
                </div>
                <p className="mt-2 text-xs text-white/70">{c.balanceLabel} · {chainNameForId(deployment.chainId)}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <AgentStoreLink locale={locale} className={`rounded-xl border border-white/30 px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 ${focus}`}>{c.storeCta}</AgentStoreLink>
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
        {address && AgentPurchases ? <AgentPurchases address={address} locale={locale} c={purchases} isConnected={isConnected} /> : null}
      </div>
    </section>
  );
}
