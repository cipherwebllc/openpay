'use client';

// 「受け取る (Receive)」: 店舗向けの決済 QR / Tip widget 作成ハブ。
// 旧 / の中身 (QR / Tip タブ + offramp section) を AppShell の下に移行。
// AppShell が logo + nav + wallet badge を担うため、ここでは個別 header を持たない。

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowRightLeft, ChevronDown, ChevronRight, Fuel } from 'lucide-react';
import { AppShell } from '@/components/AppShell';
import { BillingDueBanner } from '@/components/BillingDueBanner';
import { MiniHistoryRecent } from '@/components/MiniHistoryRecent';
import { QrGenerator } from '@/components/QrGenerator';
import { OrdersTabBadge } from '@/components/OrdersTabBadge';
import { StoreDeviceProvider, useStoreDeviceMode } from '@/components/StoreDeviceProvider';
import { env } from '@/lib/env';
import type { Locale } from '@/i18n';
import { getExchangeLink } from '@/lib/links';
import { TOKEN_SYMBOLS, type TokenSymbol } from '@/lib/tokens';
import { resolveCreateTab, type CreateTab as Tab } from '@/lib/createTab';

// タブ本体の遅延ロード (First Load JS 削減)。既定タブ 'qr' の QrGenerator だけは
// 初回ペイントそのものなので静的 import のまま残す。他パネルは SSR 時点では
// 必ず tab==='qr' (deep-link の ?tab= はマウント後の useEffect で反映) なので
// HTML には元から出ておらず、ssr:false による描画差分は生じない。
// SEO 対象の本文も持たない (ログイン後の作成ハブ)。
const TabPanelFallback = () => <div className="min-h-[200px]" />;

const RegisterMode = dynamic(
  () => import('@/components/RegisterMode').then((m) => m.RegisterMode),
  { ssr: false, loading: TabPanelFallback },
);
const TodayCard = dynamic(
  () => import('@/components/TodayCard').then((m) => m.TodayCard),
  { ssr: false },
);
const TipEmbedGenerator = dynamic(
  () =>
    import('@/components/TipEmbedGenerator').then((m) => m.TipEmbedGenerator),
  { ssr: false, loading: TabPanelFallback },
);
const HandleProfileBuilder = dynamic(
  () =>
    import('@/components/HandleProfileBuilder').then(
      (m) => m.HandleProfileBuilder,
    ),
  { ssr: false, loading: TabPanelFallback },
);
const MobileOrderBuilder = dynamic(
  () =>
    import('@/components/MobileOrderBuilder').then((m) => m.MobileOrderBuilder),
  { ssr: false, loading: TabPanelFallback },
);
const OrderFeedPanel = dynamic(
  () => import('@/components/OrderFeedPanel').then((m) => m.OrderFeedPanel),
  { ssr: false, loading: TabPanelFallback },
);
const StoreDevicePageStatus = dynamic(
  () => import('@/components/StoreDevicePageStatus').then((m) => m.StoreDevicePageStatus),
  { ssr: false },
);
const CreatorStoreSellerPanel = dynamic(() =>
  import('@/components/CreatorStoreSellerPanel').then(
    (module) => module.CreatorStoreSellerPanel,
  ),
);

// 「お店の端末で送る」の状態はタブの外に 1 つ (タブを切り替えて部品が外れても、送信と結果の表示が続く・
// components/StoreDeviceProvider.tsx)。
export default function CreatePage() {
  return (
    <StoreDeviceProvider>
      <CreatePageBody />
    </StoreDeviceProvider>
  );
}

function CreatePageBody() {
  const tabBarRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState<Tab>('qr');
  const [publishedHandle, setPublishedHandle] = useState<string | null>(null);
  const t = useTranslations('Create');
  const locale = useLocale() as Locale;
  const storeDevice = useStoreDeviceMode();
  // お店の端末が支払いを送っている・結果を待っている間はタブを切り替えさせない (別のタブで通常の QR を出して
  // 同じ会計を二重に払わせない)。署名を待っている・閉じた QR の締め切りを待っている受け渡しは、移る前に締め切る
  // (署名が入っていたら端末が送るので移らない)。
  const [tabLocked, setTabLocked] = useState(false);
  // 結果が出て送っていなくなったら、前に押したときの「切り替えられません」を消す (次の会計で出し直さない)。
  const storeDeviceBusy = storeDevice.device.busy;
  useEffect(() => {
    if (!storeDeviceBusy) setTabLocked(false);
  }, [storeDeviceBusy]);
  const showTab = (nextTab: Tab) => {
    setTabLocked(false);
    setTab(nextTab);
    if (nextTab !== 'profile') setPublishedHandle(null);
  };
  const changeTab = (nextTab: Tab) => {
    // flag OFF ではお店の端末の状態を見ない (通信もしない・今までと同じ)。
    const guarded = env.enableStoreGasWallet && nextTab !== tab;
    if (guarded && storeDevice.device.busy) {
      setTabLocked(true);
      return;
    }
    if (guarded && storeDevice.device.hasPendingSale()) {
      void storeDevice.device.leave().then((ok) => (ok ? showTab(nextTab) : setTabLocked(true)));
      return;
    }
    showTab(nextTab);
  };

  // `/create?tab=mobileOrder` 等の deep-link で初期タブを切替える (LP のバナー CTA 用)。
  // useSearchParams は Suspense 必須化を招くため使わず、マウント後に window から1回だけ読む
  // (SSR とハイドレーションは既定 'qr' で一致 → mismatch 無し)。flag OFF/未知値は resolveCreateTab
  // が 'qr' に落とす。?tab= が無いときは何もしない。
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab');
    if (!requested) return;
    setTab(
      resolveCreateTab(requested, {
        mobileOrder: env.enableMobileOrder,
        ordersFeed: env.enableOrderRelay || env.enableShopLive,
        handles: env.enableHandles,
      }),
    );
  }, []);

  useEffect(() => {
    const bar = tabBarRef.current;
    const active = activeTabRef.current;
    if (!bar || !active) return;
    const barRect = bar.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    // 横方向だけ動かし、本文の縦スクロール位置は維持する。
    if (activeRect.left < barRect.left || activeRect.right > barRect.right) {
      bar.scrollLeft += activeRect.left - barRect.left
        + activeRect.width / 2 - bar.clientWidth / 2;
    }
  }, [tab]);

  return (
    <AppShell>
      <BillingDueBanner />
      {/* 市場レートの帯は出さない (JPYC は 1:1・USDC は金額の下に「≈ ¥」とレートを出す・2026-10 磨き上げ P1 / user 裁定)。 */}

      {/* タブ名で用途が分かるので、タブの下に説明の行は出さない (2026-10 磨き上げ P1)。
          タブバー: inline-flex のまま (flex にすると desktop で全幅に伸びる)。flex-nowrap +
          overflow-x-auto + 各ボタン whitespace-nowrap/shrink-0 で、ラベル短縮済みでもスマホ
          (360–390px) で 1 行を保ち、将来タブが増えても横スクロールで崩れない。 */}
      <div ref={tabBarRef} className="mb-5 inline-flex max-w-full flex-nowrap overflow-x-auto rounded-xl bg-slate-100/80 p-1 ring-1 ring-slate-200/60 print:hidden">
        {(
          [
            ['qr', t('tabs.qr')],
            ['register', t('tabs.register')],
            // 「モバイルオーダー」は flag ON のときだけ露出 (レジとチップの間・既定 OFF=本番非表示)。
            ...(env.enableMobileOrder
              ? ([['mobileOrder', t('tabs.mobileOrder')]] as const)
              : []),
            // 「受注」は 受注リレー or 営業中の操作 (shop-live) のどちらかが ON なら露出
            // (既定 OFF=本番非表示)。営業中の操作 はこのタブに移設したので shop-live 単独でも開けるように。
            ...(env.enableOrderRelay || env.enableShopLive
              ? ([['orders', t('tabs.orders')]] as const)
              : []),
            ['tip', t('tabs.tip')],
            // 「プロフ」(@handle link-in-bio) は flag ON のときだけ露出。
            ...(env.enableHandles
              ? ([['profile', t('tabs.profile')]] as const)
              : []),
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            ref={tab === id ? activeTabRef : null}
            type="button"
            onClick={() => changeTab(id)}
            className={`shrink-0 whitespace-nowrap rounded-lg px-4 py-2 text-sm transition-all duration-200 ${
              tab === id
                ? 'bg-white font-semibold text-brand-dark shadow-card ring-1 ring-slate-200/60'
                : 'font-medium text-slate-500 hover:text-slate-800'
            }`}
          >
            {label}
            {id === 'orders' ? <OrdersTabBadge /> : null}
          </button>
        ))}
      </div>

      {tabLocked && storeDevice.device.busy && (
        <p role="alert" className="mb-4 text-sm text-amber-800">
          {t('storeDeviceTabLocked')}
        </p>
      )}

      {/* レジ以外のタブでも、お店の端末が送った支払いの行方は隠さない (レジでは会計ボタンの下に出る)。 */}
      {env.enableStoreGasWallet && tab !== 'register' && storeDevice.device.state.phase !== 'idle' && (
        <StoreDevicePageStatus />
      )}

      {tab === 'qr' && <QrGenerator />}
      {tab === 'register' && (
        <div className="space-y-5">
          <TodayCard />
          <RegisterMode
            {...(env.enableMobileOrder ? { onStartMobileOrder: () => changeTab('mobileOrder') } : {})}
          />
        </div>
      )}
      {tab === 'tip' && (
        <div className="space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">
              {t('tipPanel.heading')}
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {t('tipPanel.subheading')}
            </p>
          </div>
          <TipEmbedGenerator />
        </div>
      )}
      {tab === 'profile' && env.enableHandles && (
        env.enableCreatorStoreUi ? (
          <div className="space-y-6">
            <HandleProfileBuilder
              onPublishedHandleChange={setPublishedHandle}
            />
            <CreatorStoreSellerPanel handle={publishedHandle} />
          </div>
        ) : (
          <HandleProfileBuilder />
        )
      )}
      {tab === 'mobileOrder' && env.enableMobileOrder && (
        <MobileOrderBuilder
          onManageProducts={() => changeTab('register')}
          onGetHandle={() => changeTab('profile')}
        />
      )}
      {tab === 'orders' && (env.enableOrderRelay || env.enableShopLive) && <OrderFeedPanel />}

      {/* 受注・プロフタブでは下部の参照系 (最近の取引 / 換金) を隠す。 */}
      {tab !== 'orders' && tab !== 'profile' && <MiniHistoryRecent />}

      {/* 換金は受け取った後の話で会計の最中には使わないので、1 行に畳む (中身・文言はそのまま)。 */}
      {tab !== 'orders' && tab !== 'profile' && (
      <details className="group/offramp mt-6 rounded-2xl bg-white shadow-card ring-1 ring-slate-200/70 print:hidden">
        <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
          <ArrowRightLeft className="h-4 w-4 flex-none text-slate-400" aria-hidden />
          <h2
            id="offramp-heading"
            className="flex-1 text-sm font-medium text-slate-700"
          >
            {t('offramp.heading')}
          </h2>
          <ChevronDown
            className="h-4 w-4 flex-none text-slate-400 transition-transform group-open/offramp:rotate-180"
            aria-hidden
          />
        </summary>
        <div className="border-t border-slate-100 px-5 pb-5 pt-3">
        <p className="text-[11px] text-slate-500">{t('offramp.subheading')}</p>
        <ul className="mt-3 space-y-2">
          {TOKEN_SYMBOLS.map((token) => {
            const link = getExchangeLink(token, locale);
            return (
              <li
                key={token}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
              >
                <TokenIcon token={token} />
                <span className="text-slate-700">
                  {t('offramp.row', { token: token.toUpperCase() })}
                </span>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand hover:underline"
                >
                  {link.label} ↗
                </a>
                {link.jaResidentsOnly && (
                  <span className="text-xs text-slate-500">
                    {t('offramp.jaResidentsOnlyNote')}
                  </span>
                )}
                {link.blocksJapaneseResidents && (
                  <span className="text-xs text-slate-500">
                    {t('offramp.japaneseUserHint')}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-[11px] text-slate-500">{t('offramp.hint')}</p>
        {/* JPYC の DeFi 運用ガイド (note・外部)。ウォレット準備〜換金・運用の参考導線。 */}
        <a
          href="https://note.com/masia02/n/ned04a4cdb00a"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          {t('offramp.guideLink')} ↗
        </a>

        <details className="group mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900 open:pb-4">
          <summary className="flex cursor-pointer list-none items-center gap-2 font-semibold">
            <Fuel className="h-4 w-4" aria-hidden />
            <span className="flex-1">{t('offramp.gasHint.title')}</span>
            <ChevronRight
              className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
              aria-hidden
            />
          </summary>
          <p className="mt-2 leading-relaxed">{t('offramp.gasHint.body')}</p>
          <a
            href="https://portfolio.metamask.io/swap"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block font-medium text-amber-900 underline hover:text-amber-700"
          >
            {t('offramp.gasHint.linkLabel')} ↗
          </a>
          <p className="mt-2 text-[11px] text-amber-800">
            {t('offramp.gasHint.disclaimer')}
          </p>
        </details>
        </div>
      </details>
      )}

      {/* 販売ハブとしての用途別ガイド入口 (P5・plans/site-ia-guides-ruling.md N10)。 */}
      {tab !== 'profile' && (
        <section className="mt-10">
          <h2 className="text-sm font-semibold text-slate-500">
            {t('guideLinks.title')}
          </h2>
          <ul className="mt-2 space-y-1.5">
            {(
              [
                ['qr', 'qr'],
                ['shop', 'shop'],
                ['store', 'store'],
              ] as const
            ).map(([key, slug]) => (
              <li key={key}>
                <Link
                  href={`/${locale}/guide/${slug}`}
                  prefetch={false}
                  className="text-sm font-medium text-emerald-700 underline-offset-2 hover:underline"
                >
                  {t(`guideLinks.${key}`)} →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </AppShell>
  );
}

function TokenIcon({ token }: { token: TokenSymbol }) {
  const fg = token === 'jpyc' ? '#1e40af' : '#047857';
  const bg = token === 'jpyc' ? '#dbeafe' : '#d1fae5';
  const glyph = token === 'jpyc' ? '¥' : '$';
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="11" fill={bg} stroke={fg} strokeWidth="1.2" />
      <text
        x="12"
        y="16.5"
        textAnchor="middle"
        fontSize="14"
        fontWeight="700"
        fill={fg}
        fontFamily="ui-sans-serif, system-ui, sans-serif"
      >
        {glyph}
      </text>
    </svg>
  );
}
