// 決済モードの 3 つ目「お店がガス代を肩代わりして送る」(内部名「お店の端末で送る」・plans/store-gas-wallet.md §19)。
// 設定 (QrSettings.storePays) は店主が選んだまま消さず、「いま使えるか」はここで導出する (レジの商品で通貨が
// 暗黙に切り替わっても、JPYC・対象チェーンに戻れば選んだ状態が戻る = 黙って通常のガスレスに変わらない)。

import { chainForSlug, type ChainSlug } from './chains';
import { env } from './env';
import { isStoreDeviceChain } from './storeDevicePayment';
import type { PayMode } from './fee';
import type { TokenSymbol } from './tokens';

type StorePaysSettings = { storePays?: boolean; payMode: PayMode; token: TokenSymbol; chain: ChainSlug };

/**
 * 店主が「お店がガス代を肩代わりして送る」を選んでいる (flag ON のときだけ意味を持つ)。3 つ目のカードは
 * {payMode: 'gasless', storePays: true} なので、通常決済 (standard) のときは選んでいない (ガスレス非対応の
 * チェーンで standard に倒れたときも同じ)。
 */
export function storePaysRequested(s: StorePaysSettings): boolean {
  return env.enableStoreGasWallet && s.storePays === true && s.payMode === 'gasless';
}

/** 選んでいて、いまの通貨・チェーン (JPYC・lib/storeDevicePayment.ts の storeDeviceChainIds のチェーン) で使える。 */
export function storePaysActive(s: StorePaysSettings): boolean {
  return storePaysRequested(s) && s.token === 'jpyc' && isStoreDeviceChain(chainForSlug(s.chain).id);
}
