import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import {
  RELAY_INTENT_PROBE_KEY,
  RELAY_INTENT_STORAGE_KEY,
  canStoreRelayIntent,
  clearRelayIntent,
  loadRelayIntent,
  saveRelayIntent,
  saveRelayIntentVerified,
  type RelayIntentMetadata,
} from '@/lib/paymentIntentStorage';

// 第 10 回レビュー H-R: 決済の relay の枠 (openpay:relay-intent:v1) を「書けたか」まで確かめる 2 つの関数。
// 束縛しない支払い (hooks/useJpycEip3009Payment) だけが使う。共有の save() / load() と saveRelayIntent の振る舞い
// (書き込みの失敗を投げない) は tests/lib/paymentIntentStorage.test.ts が固定していて、ここでは変えていないことも見る。
// 差し替えるのは Storage の境界だけ。

const FROM = '0x1111111111111111111111111111111111111111' as Address;
const MERCHANT = '0x2222222222222222222222222222222222222222' as Address;
const NONCE = `0x${'3'.repeat(64)}` as Hex;
const SIGNATURE = `0x${'4'.repeat(130)}` as Hex;
const ORDER_LINK_KEY = `0x${'a7'.repeat(32)}` as Hex;

function relayIntent(): RelayIntentMetadata {
  return {
    chainId: 80002,
    from: FROM,
    merchant: MERCHANT,
    merchantValue: '1000000000000000000',
    feeValue: '2000000000000000000',
    nonce: NONCE,
    validBefore: '9999999999',
    routeKind: 'recover',
    issuedAt: 1_700_000_000_000,
  };
}

function quotaExceeded(): never {
  throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
}

function accessDenied(): never {
  throw new DOMException('Access is denied for this document.', 'SecurityError');
}

beforeEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

// 署名を求める前に、枠と同じ中身を別のキーに書いて読み戻せるかを確かめる。
describe('relay payment intent: 署名の前の確かめ (canStoreRelayIntent)', () => {
  it('書けて読み戻せる端末では true。枠のキーには書かず、確かめのキーも残さない', () => {
    expect(RELAY_INTENT_PROBE_KEY).not.toBe(RELAY_INTENT_STORAGE_KEY);
    const written: [string, string][] = [];
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      written.push([key, value]);
      real.call(this, key, value);
    });
    expect(canStoreRelayIntent({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY })).toBe(true);
    spy.mockRestore();
    expect(window.sessionStorage.length).toBe(0);
    // 書いたのは確かめのキーに 1 回・中身は枠と同じ (同じ長さ = 枠が入る余地を確かめている)。
    saveRelayIntent({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY });
    const slot = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    expect(slot).not.toBeNull();
    expect(written).toEqual([[RELAY_INTENT_PROBE_KEY, slot]]);
  });

  it('未解決の支払いの枠があっても、その枠に触れない', () => {
    saveRelayIntent(relayIntent());
    const other = { ...relayIntent(), nonce: `0x${'9'.repeat(64)}` as Hex };
    expect(canStoreRelayIntent(other)).toBe(true);
    expect(loadRelayIntent()).toEqual(relayIntent());
    expect(window.sessionStorage.length).toBe(1);
  });

  it('署名や余分な field は確かめのキーにも書かない', () => {
    const real = Storage.prototype.setItem;
    let raw = '';
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      raw = value;
      real.call(this, key, value);
    });
    expect(
      canStoreRelayIntent({ ...relayIntent(), signature: SIGNATURE } as RelayIntentMetadata & { signature: Hex }),
    ).toBe(true);
    spy.mockRestore();
    expect(raw).not.toContain(SIGNATURE);
    expect(JSON.parse(raw)).toEqual(relayIntent());
  });

  it('書き込みが throw する端末 (容量超過・保存の禁止) では false (throw しない)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(quotaExceeded);
    expect(canStoreRelayIntent(relayIntent())).toBe(false);
  });

  it('書いたものが読み戻せない端末 (投げずに捨てる・読むと throw) では false', () => {
    const dropped = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(canStoreRelayIntent(relayIntent())).toBe(false);
    dropped.mockRestore();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(accessDenied);
    expect(canStoreRelayIntent(relayIntent())).toBe(false);
  });

  it('sessionStorage そのものに触れない端末 (window.sessionStorage の getter が throw) では false (throw しない)', () => {
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(accessDenied);
    try {
      expect(canStoreRelayIntent(relayIntent())).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('枠として読めない形 (読み戻しても復元できない) は false で、何も書かない', () => {
    expect(canStoreRelayIntent({ ...relayIntent(), nonce: '0x1234' as Hex })).toBe(false);
    expect(window.sessionStorage.length).toBe(0);
  });

  // Codex の再現 (NIT): 読み戻しの getItem が投げると、今までは確かめのキーが残っていた。
  it('読み戻しが投げた端末でも確かめのキーを残さない (枠には触れない)', () => {
    saveRelayIntent(relayIntent());
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(accessDenied);
    expect(canStoreRelayIntent({ ...relayIntent(), nonce: `0x${'9'.repeat(64)}` as Hex })).toBe(false);
    read.mockRestore();
    expect(window.sessionStorage.getItem(RELAY_INTENT_PROBE_KEY)).toBeNull();
    expect(loadRelayIntent()).toEqual(relayIntent());
  });

  it('読み戻しも消すのも投げる端末でも false を返すだけ (throw しない)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(accessDenied);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(accessDenied);
    expect(canStoreRelayIntent(relayIntent())).toBe(false);
  });
});

// 署名の後・POST の前に、枠そのものを書いて読み戻す。
describe('relay payment intent: 書いて読み戻す (saveRelayIntentVerified)', () => {
  it('書けた枠は saveRelayIntent と同じ中身で、true を返す', () => {
    expect(saveRelayIntentVerified({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY })).toBe(true);
    const verified = window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY);
    expect(window.sessionStorage.length).toBe(1);
    clearRelayIntent();
    saveRelayIntent({ ...relayIntent(), orderLinkKey: ORDER_LINK_KEY });
    expect(verified).toBe(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY));
  });

  it('address・nonce の大文字小文字の違いは同じ枠として読む', () => {
    const mixed = {
      ...relayIntent(),
      from: `0x${'aB'.repeat(20)}` as Address,
      nonce: `0x${'Cd'.repeat(32)}` as Hex,
    };
    expect(saveRelayIntentVerified(mixed)).toBe(true);
  });

  it('書き込みが throw する端末では false (throw しない)。saveRelayIntent は今までどおり投げない', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(quotaExceeded);
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    expect(() => saveRelayIntent(relayIntent())).not.toThrow();
    spy.mockRestore();
    expect(loadRelayIntent()).toBeNull();
  });

  it('書き込みを黙って捨てる端末・読むと throw する端末では false', () => {
    const dropped = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    dropped.mockRestore();

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(accessDenied);
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
  });

  it('sessionStorage そのものに触れない端末 (window.sessionStorage の getter が throw) では false (throw しない)', () => {
    const spy = vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(accessDenied);
    try {
      expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  // 書き込みが失敗したとき、枠に残っている別の支払いの記録を「いま書いた枠」と読み違えない。
  it.each([
    ['nonce', { nonce: `0x${'9'.repeat(64)}` as Hex }],
    ['from', { from: '0x5555555555555555555555555555555555555555' as Address }],
    ['chainId', { chainId: 137 }],
  ] as const)('書けなかったときに枠に残っている、%s が違う記録では false (その記録は消さない)', (_field, diff) => {
    const stale = { ...relayIntent(), ...diff };
    saveRelayIntent(stale);
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(quotaExceeded);
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    spy.mockRestore();
    expect(loadRelayIntent()).toEqual(stale);
  });

  // Codex の再現 (SHOULD): 書けたが読み戻しが投げた (または違う形で読めた) とき、この試みの記録 (まだ送っていない) が
  // 枠に残ると、読めるようになった後に開き直した画面が「送信済みかもしれない」として塞ぐ。消してよい根拠があるときだけ消す。
  // 書き込みの後の最初の読み戻しだけを投げさせる (書く前の読みは通る)。
  function failReadBackOnce(): void {
    const realSet = Storage.prototype.setItem;
    const realGet = Storage.prototype.getItem;
    let wroteSlot = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === RELAY_INTENT_STORAGE_KEY) wroteSlot = true;
      realSet.call(this, key, value);
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === RELAY_INTENT_STORAGE_KEY && wroteSlot) {
        wroteSlot = false;
        return accessDenied();
      }
      return realGet.call(this, key);
    });
  }

  it('書く前の枠が空で、書けたが読み戻しが投げた → false で、この試みの記録を片づける', () => {
    failReadBackOnce();
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    vi.restoreAllMocks();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('書く前の枠がこの authorization (同じ nonce・IP 制限の後の再送) で、読み戻しが投げた → 片づける', () => {
    saveRelayIntent(relayIntent());
    failReadBackOnce();
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    vi.restoreAllMocks();
    expect(window.sessionStorage.getItem(RELAY_INTENT_STORAGE_KEY)).toBeNull();
  });

  it('書く前に別の支払いの記録があった → 読み戻せなくても枠を消さない (別の支払いの記録を消さない・fail-closed)', () => {
    const other = { ...relayIntent(), nonce: `0x${'9'.repeat(64)}` as Hex };
    saveRelayIntent(other);
    // 書き込みを黙って捨てる端末: 枠に残るのは別の支払いの記録。
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => undefined);
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    vi.restoreAllMocks();
    expect(loadRelayIntent()).toEqual(other);

    // 書けたが読み戻しが投げた: 枠にあるのはこの試みの記録だが、書く前に別の記録があったので消さない
    // (限界: 期限が証明されるまで「送信済みかもしれない」で塞ぎうる。二重払いではない)。
    failReadBackOnce();
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    vi.restoreAllMocks();
    expect(loadRelayIntent()).toEqual(relayIntent());
  });

  it('書く前の枠を読めなかった → 根拠が無いので消さない (fail-closed)', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(accessDenied);
    const removed = vi.spyOn(Storage.prototype, 'removeItem');
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
    expect(removed).not.toHaveBeenCalled();
  });

  it('片づけ (removeItem) が投げても false を返すだけ (throw しない)', () => {
    failReadBackOnce();
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(accessDenied);
    expect(saveRelayIntentVerified(relayIntent())).toBe(false);
  });
});
