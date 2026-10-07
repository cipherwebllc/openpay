'use client';

// 「お店の端末で送る」(店員向けの名前は「お店がガス代を肩代わりして送る」) の結果を、レジ以外のタブでも見せる
// (作成ページのタブの外・plans/store-gas-wallet.md §19)。再読み込みの後に前のタブの受け渡しを締め切って送ったとき
// など、レジを開いていなくても支払いの行方 (送っている・入金の確認・結果が分からない) を隠さない。
// 「QR を出し直す」「通常の QR を出す」は出さない (会計の内容と結びつくので、QR を出したタブで行う)。「もう一度送る」は
// 出す (決済QRタブの会計もここで続ける)。通常の QR はどのタブでも受け渡しを締め切り「もう一度送る」を使えなくしてから
// 出し (releaseForNormal)、タブを移るときも使えなくする (leave) ので、通常の QR で払った後に同じ署名を送らない。

import { useTranslations } from 'next-intl';
import { formatUnits } from 'viem';
import { StoreDeviceRegisterStatus } from '@/components/StoreDeviceRegisterStatus';
import { useStoreDeviceMode } from '@/components/StoreDeviceProvider';

export function StoreDevicePageStatus() {
  const t = useTranslations('Create');
  const { device, chainId, deployment } = useStoreDeviceMode();
  if (device.state.phase === 'idle') return null;
  return (
    <section aria-label={t('storeDeviceStatusLabel')} className="mb-4 space-y-2 rounded-2xl bg-white px-4 py-3 shadow-card ring-1 ring-slate-200/70 print:hidden">
      <p className="text-xs font-semibold text-slate-500">{t('storeDeviceStatusLabel')}</p>
      <StoreDeviceRegisterStatus
        state={device.state}
        chainId={chainId}
        formatAmount={(wei) =>
          `${formatUnits(BigInt(wei), deployment?.decimals ?? 18)} ${deployment?.displaySymbol ?? 'JPYC'}`
        }
        onCheckNow={() => void device.checkNow()}
        onRetry={device.retry}
        onDismiss={device.dismiss}
      />
    </section>
  );
}
