import { describe, it, expect, vi } from 'vitest';
import type { Address } from 'viem';
import {
  buildPayPath,
  buildPayUrl,
  parsePayParams,
  buildTipPath,
  buildTipUrl,
  parseTipParams,
  parseSplitDrafts,
  DEFAULT_TIP_PRESETS,
  searchParamsFromNext,
} from '@/lib/url';

// USDC (Base) のアドレスは checksum 既知のため、テストの roundtrip が安定する。
const VALID_TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('buildPayPath', () => {
  it('amount を含めてビルド (mode=gasless は URL に出さない)', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      gas: 'customer',
      amount: '10.5',
      mode: 'gasless',
    });
    expect(path).toBe(
      `/pay?to=${VALID_TO}&token=usdc&amount=10.5`,
    );
    expect(path).not.toContain('mode=');
  });

  it('amount を省略してビルド', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'jpyc',
      gas: 'customer',
      mode: 'gasless',
    });
    expect(path).toBe(`/pay?to=${VALID_TO}&token=jpyc`);
    expect(path).not.toContain('amount');
  });

  it('amount=空文字列 は省略されたものとみなす', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      gas: 'customer',
      amount: '',
      mode: 'gasless',
    });
    expect(path).not.toContain('amount');
  });

  it('mode=standard のときだけ URL に mode=standard を出す', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'jpyc',
      gas: 'customer',
      amount: '1000',
      mode: 'standard',
    });
    expect(path).toContain('mode=standard');
  });

  it('mode=standard かつ gas=merchant のとき、gas= は URL に出さない (standard では gas が irrelevant)', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      gas: 'merchant',
      amount: '100',
      mode: 'standard',
    });
    expect(path).toContain('mode=standard');
    expect(path).not.toContain('gas=');
  });
});

describe('buildPayUrl', () => {
  it('origin を前置する', () => {
    const url = buildPayUrl('https://openpay.example.com', {
      to: VALID_TO,
      token: 'usdc',
      gas: 'customer',
      amount: '5',
      mode: 'gasless',
    });
    expect(url).toBe(
      `https://openpay.example.com/pay?to=${VALID_TO}&token=usdc&amount=5`,
    );
  });
});

describe('parsePayParams', () => {
  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('全パラメータが揃う場合に成功 (mode 省略 → gasless)', () => {
    const r = parsePayParams(
      search(
        `to=${VALID_TO}&token=usdc&amount=10`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('usdc');
      expect(r.params.amount).toBe('10');
      expect(r.params.mode).toBe('gasless');
    }
  });

  it('mode=standard を読み取る', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&mode=standard`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('standard');
  });

  it('legacy alias: mode=direct → standard に正規化される (旧 QR 互換)', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&mode=direct`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('standard');
  });

  it('mode=gasless を明示しても受け入れる', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&mode=gasless`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('gasless');
  });

  it('mode が unsupported → エラー', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&mode=meta`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('mode');
  });

  it('to が無い + 他 param あり → invalid (URL 半壊)', () => {
    const r = parsePayParams(search('token=usdc'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('to');
      expect(r.errorKind).toBe('invalid');
    }
  });

  it('search 完全空 → errorKind=empty (bare /pay landing 用 signal)', () => {
    const r = parsePayParams(search(''));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('empty');
      expect(r.error).toContain('to');
    }
  });

  it('search に unrelated key だけある → errorKind=empty (PAY_PARAM_KEYS 集合のみ判定)', () => {
    // 無関係な query (utm_source 等) のみのときも landing 扱い
    const r = parsePayParams(search('utm_source=ad'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('empty');
    }
  });

  it('to が address 形式不正 → errorKind=invalid', () => {
    const r = parsePayParams(search('to=0xnotanaddress&token=usdc'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
    }
  });

  it('to= (空文字列) + token → errorKind=invalid (URL に "?to=" がある = 何か指定の意図)', () => {
    const r = parsePayParams(search('to=&token=usdc'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
      expect(r.error).toContain('to');
    }
  });

  it('to= (空) のみで他無し → errorKind=invalid (token も既に欠落だが to= 自体は 「PAY_PARAM_KEYS」 に該当する key)', () => {
    const r = parsePayParams(search('to='));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // searchParams.get('to') === '' (not null) なので PAY_PARAM_KEYS に該当
      expect(r.errorKind).toBe('invalid');
    }
  });

  it('zero address (0x000…) は isAddress=true で受理される (現挙動を固定化)', () => {
    const zero = `0x${'0'.repeat(40)}`;
    const r = parsePayParams(search(`to=${zero}&token=usdc&amount=10`));
    // 受理されることが現在の挙動。意図的に拒否する場合は別途 validation 層を足す必要がある。
    expect(r.ok).toBe(true);
  });

  it('chain が不正値 → errorKind=invalid + chain メッセージ', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=avalanche`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
      expect(r.error).toContain('chain');
      // kaia + ethereum を含む 6 候補列挙
      expect(r.error).toContain('kaia');
      expect(r.error).toContain('ethereum');
    }
  });

  it('chain=ethereum + usdc + mode=standard → 受理 (Ethereum L1 USDC standard 経路)', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=ethereum&mode=standard`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.chain).toBe('ethereum');
      expect(r.params.mode).toBe('standard');
    }
  });

  it('chain=ethereum + usdc + mode=gasless → errorKind=invalid (Pimlico ERC20 paymaster 未対応)', () => {
    // gasless は省略可 (default) なので mode を明示せず → default gasless で reject
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=ethereum`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
      expect(r.error).toContain('gasless');
      expect(r.error).toContain('ethereum');
    }
  });

  it('chain=ethereum + usdc + mode=gasless 明示 → errorKind=invalid', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=ethereum&mode=gasless`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
      expect(r.error).toContain('standard');
    }
  });

  it('chain=kaia + usdc → errorKind=invalid (kaia には native USDC 未 deploy)', () => {
    // isValidChainSlug は kaia を accept するが、hasDeployment('usdc', 'kaia') は
    // false (UsdcChainSlug = Exclude<ChainSlug, 'kaia'> の型レベル除外の runtime 確認)
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=kaia`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
      expect(r.error).toContain('usdc');
      expect(r.error).toContain('kaia');
    }
  });

  it('jpyc + arbitrum (未対応 deployment) → errorKind=invalid', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=jpyc&chain=arbitrum`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errorKind).toBe('invalid');
      expect(r.error).toContain('jpyc');
    }
  });

  it('jpyc + kaia: env override 無しでも hard-code default で deployment 存在し受理される', async () => {
    // 2026-05-23: hard-code default 採用後の挙動。env 未設定でも JPYC v3 cross-chain
    // 同一 address が hard-code されているため、parser は受理する。
    const previousKairos = process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS;
    delete process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS;
    vi.resetModules();
    const mod = await import('@/lib/url');
    const r = mod.parsePayParams(
      new URLSearchParams(`to=${VALID_TO}&token=jpyc&chain=kaia`),
    );
    if (previousKairos !== undefined) {
      process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS = previousKairos;
    }
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('jpyc');
      expect(r.params.chain).toBe('kaia');
    }
  });

  it('jpyc + kaia: KAIROS_ADDRESS 設定済なら deployment 存在で受理される (codex P1 regression fence)', async () => {
    // 直前の codex review で発覚した本物の bug:
    // useQrSettings は jpyc+kaia を保存し buildPayPath は QR に乗せるのに、
    // lib/url.ts の hasDeployment が hard-coded jpyc=polygon で reject して
    // いた → 生成された Kaia QR は parser に拒否され決済不能だった。
    // 修正後は TOKEN_DEPLOYMENTS の実 deployment を見るので env 設定済なら
    // 受理されることを fence。
    const previousKairos = process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS;
    process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS =
      '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29';
    vi.resetModules();
    const mod = await import('@/lib/url');
    const r = mod.parsePayParams(
      new URLSearchParams(`to=${VALID_TO}&token=jpyc&chain=kaia`),
    );
    if (previousKairos === undefined) {
      delete process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS;
    } else {
      process.env.NEXT_PUBLIC_JPYC_KAIROS_ADDRESS = previousKairos;
    }
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('jpyc');
      expect(r.params.chain).toBe('kaia');
    }
  });

  it('to がアドレス形式でない → エラー', () => {
    const r = parsePayParams(
      search('to=0xnotanaddress&token=usdc'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不正');
  });

  it('token が無い → エラー', () => {
    const r = parsePayParams(search(`to=${VALID_TO}`));
    expect(r.ok).toBe(false);
  });

  it('token が unsupported → エラー', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=eth`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('jpyc');
  });

  it('chain が無効な slug (例 avalanche) → エラー (どの USDC chain か明示しろ)', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=avalanche`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('chain');
  });

  it('chain が文字化け (大文字 / 空白入り) → エラー', () => {
    // isValidChainSlug は厳密一致なので "BASE" や "base " は通らない
    const r1 = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=BASE`),
    );
    expect(r1.ok).toBe(false);
    const r2 = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&chain=base%20`),
    );
    expect(r2.ok).toBe(false);
  });

  it('jpyc + arbitrum / base / optimism (jpyc 未対応 chain) → エラー', () => {
    // chain 自体は valid slug だが、jpyc は polygon のみ deployment あり。
    // hasDeployment ガード (lib/url.ts:255) を踏むことで silent fund misdirection
    // (jpyc を arbitrum に送って永久消失) を防いでいる。
    for (const chain of ['arbitrum', 'base', 'optimism'] as const) {
      const r = parsePayParams(
        search(`to=${VALID_TO}&token=jpyc&chain=${chain}`),
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('jpyc');
        expect(r.error).toContain(chain);
      }
    }
  });

  it('旧 fee パラメタ (include/exclude/任意値) は silently ignore (古い QR の互換)', () => {
    // 旧 QR では `fee=include` 等が含まれる。新モデルでは exclude 一本固定なので
    // パラメタ自体を捨て、parse は成功させる (URL を破壊しない)。
    for (const fee of ['include', 'exclude', 'foo', '']) {
      const r = parsePayParams(
        search(`to=${VALID_TO}&token=usdc&fee=${fee}`),
      );
      expect(r.ok).toBe(true);
    }
  });

  it('小文字アドレスは checksum 正規化されて、元の checksum 文字列と一致する', () => {
    const lower = VALID_TO.toLowerCase() as `0x${string}`;
    const r = parsePayParams(
      search(`to=${lower}&token=jpyc`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      // 実際に元の checksum 文字列に戻っていることまで確認 (大文字小文字混在の自然な比較)
      expect(r.params.to).toBe(VALID_TO);
      expect(r.params.to).not.toBe(lower);
    }
  });

  it('amount=空文字列 は undefined として扱う', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&amount=`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.amount).toBeUndefined();
  });

  it('未知パラメータは無視', () => {
    const r = parsePayParams(
      search(
        `to=${VALID_TO}&token=usdc&xss=<script>`,
      ),
    );
    expect(r.ok).toBe(true);
  });

  it('roundtrip: build → parse で同じ値 (gasless)', () => {
    const built = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      gas: 'customer',
      amount: '12.34',
      mode: 'gasless',
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(VALID_TO);
      expect(r.params.token).toBe('usdc');
      expect(r.params.amount).toBe('12.34');
      expect(r.params.mode).toBe('gasless');
    }
  });

  it('roundtrip: build → parse で同じ値 (standard)', () => {
    const built = buildPayPath({
      to: VALID_TO,
      token: 'jpyc',
      gas: 'customer',
      amount: '1000',
      mode: 'standard',
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('standard');
  });
});

// ---------------------------------------------------------------------------
// /tip helpers
// ---------------------------------------------------------------------------

describe('buildTipPath', () => {
  it('最小: token のみ', () => {
    const path = buildTipPath({ to: VALID_TO, token: 'jpyc' });
    expect(path).toBe(`/tip/${VALID_TO}?token=jpyc`);
  });

  it('name / message / color / presets を全部含める', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'usdc',
      name: 'Alice',
      message: 'thanks!',
      color: '#1e3a8a',
      presets: ['1', '5', '10'],
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('token')).toBe('usdc');
    expect(sp.get('name')).toBe('Alice');
    expect(sp.get('message')).toBe('thanks!');
    expect(sp.get('color')).toBe('#1e3a8a');
    expect(sp.get('preset')).toBe('1,5,10');
  });

  it('color が #rrggbb 形式でなければ URL に出さない', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      color: 'red',
    });
    expect(path).not.toContain('color=');
  });

  it('color は小文字に正規化', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      color: '#ABCDEF',
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('color')).toBe('#abcdef');
  });

  it('preset は不正値を捨て最大 6 件まで', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      presets: ['100', 'abc', '0', '-5', '500', '1000', '2000', '3000', '4000', '5000'],
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('preset')).toBe('100,500,1000,2000,3000,4000');
  });

  it('preset は重複を除去して URL に出力する', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      presets: ['500', '1500', '500', '1500', '3000'],
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('preset')).toBe('500,1500,3000');
  });

  it('name / message が長すぎたら切詰める', () => {
    const longName = 'あ'.repeat(100);
    const longMessage = 'い'.repeat(300);
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      name: longName,
      message: longMessage,
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('name')!.length).toBe(60);
    expect(sp.get('message')!.length).toBe(200);
  });

  it('制御文字を除去する', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      name: 'Al\x00ice\x1f',
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('name')).toBe('Alice');
  });

  it('空文字 name は省略', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      name: '',
      message: '',
    });
    expect(path).not.toContain('name=');
    expect(path).not.toContain('message=');
  });

  it('crossChain: true (default) は URL に出さず旧 embed と互換', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'usdc',
      crossChain: true,
    });
    expect(path).not.toContain('crossChain');
  });

  it('crossChain 省略 (undefined) も URL に出さない', () => {
    const path = buildTipPath({ to: VALID_TO, token: 'usdc' });
    expect(path).not.toContain('crossChain');
  });

  it('crossChain: false のみ URL に crossChain=false を出力', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'usdc',
      crossChain: false,
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('crossChain')).toBe('false');
  });

  it('jpyc + kaia roundtrip: ?chain=kaia を出力', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      chain: 'kaia',
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('token')).toBe('jpyc');
    expect(sp.get('chain')).toBe('kaia');
  });

  it('jpyc + polygon (default) は ?chain= を出さない', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      chain: 'polygon',
    });
    expect(path).not.toContain('chain=');
  });
});

describe('buildTipUrl', () => {
  it('origin を前置する', () => {
    const url = buildTipUrl('https://openpay.example.com', {
      to: VALID_TO,
      token: 'jpyc',
      name: 'Bob',
    });
    expect(url).toBe(
      `https://openpay.example.com/tip/${VALID_TO}?token=jpyc&name=Bob`,
    );
  });
});

describe('parseTipParams', () => {
  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('最小: token のみで成功', () => {
    const r = parseTipParams(VALID_TO, search('token=jpyc'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(VALID_TO);
      expect(r.params.token).toBe('jpyc');
      expect(r.params.name).toBeUndefined();
      expect(r.params.presets).toBeUndefined();
    }
  });

  it('全パラメータパース', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=usdc&name=Alice&message=thx&color=%231e3a8a&preset=1,5,10'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('usdc');
      expect(r.params.name).toBe('Alice');
      expect(r.params.message).toBe('thx');
      expect(r.params.color).toBe('#1e3a8a');
      expect(r.params.presets).toEqual(['1', '5', '10']);
    }
  });

  it('address 無し → エラー', () => {
    const r = parseTipParams('', search('token=jpyc'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('宛先');
  });

  it('address が不正 → エラー', () => {
    const r = parseTipParams('not-an-address', search('token=jpyc'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不正');
  });

  it('小文字 address は checksum 正規化される', () => {
    const lower = VALID_TO.toLowerCase();
    const r = parseTipParams(lower, search('token=jpyc'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(VALID_TO);
      expect(r.params.to).not.toBe(lower);
    }
  });

  it('token 無し → エラー', () => {
    const r = parseTipParams(VALID_TO, search(''));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('jpyc');
  });

  it('token unsupported → エラー', () => {
    const r = parseTipParams(VALID_TO, search('token=eth'));
    expect(r.ok).toBe(false);
  });

  it('color が不正形式 → undefined にして成功', () => {
    const r = parseTipParams(VALID_TO, search('token=jpyc&color=red'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.color).toBeUndefined();
  });

  it('preset の不正値は捨て、件数上限で切る', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=jpyc&preset=100,abc,0,-1,500,1000,2000,3000,4000,5000'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.presets).toEqual([
        '100',
        '500',
        '1000',
        '2000',
        '3000',
        '4000',
      ]);
    }
  });

  it('preset の重複は parse 時にも除去する', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=jpyc&preset=500,1500,500,1500,3000'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.presets).toEqual(['500', '1500', '3000']);
    }
  });

  it('name / message が長すぎたら切詰', () => {
    const longName = 'あ'.repeat(100);
    const longMessage = 'い'.repeat(300);
    const r = parseTipParams(
      VALID_TO,
      search(
        `token=jpyc&name=${encodeURIComponent(longName)}&message=${encodeURIComponent(longMessage)}`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.name!.length).toBe(60);
      expect(r.params.message!.length).toBe(200);
    }
  });

  it('roundtrip: build → parse', () => {
    const built = buildTipPath({
      to: VALID_TO,
      token: 'usdc',
      name: 'Carol',
      message: 'Coffee, please',
      color: '#ff0080',
      presets: ['1', '3', '7'],
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('usdc');
      expect(r.params.name).toBe('Carol');
      expect(r.params.message).toBe('Coffee, please');
      expect(r.params.color).toBe('#ff0080');
      expect(r.params.presets).toEqual(['1', '3', '7']);
    }
  });

  it('crossChain 未指定 → default true', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.crossChain).toBe(true);
    }
  });

  it('crossChain=false → false', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&crossChain=false'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.crossChain).toBe(false);
    }
  });

  it('crossChain=true / 不明値 → true (= default、明示 false 以外は全部 true)', () => {
    const rTrue = parseTipParams(VALID_TO, search('token=usdc&crossChain=true'));
    expect(rTrue.ok).toBe(true);
    if (rTrue.ok) expect(rTrue.params.crossChain).toBe(true);
    const rWeird = parseTipParams(VALID_TO, search('token=usdc&crossChain=maybe'));
    expect(rWeird.ok).toBe(true);
    if (rWeird.ok) expect(rWeird.params.crossChain).toBe(true);
  });

  it('jpyc + kaia roundtrip: build → parse で chain=kaia 維持', () => {
    const built = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      chain: 'kaia',
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('jpyc');
      expect(r.params.chain).toBe('kaia');
    }
  });

  // === crossChain 値の精密 boundary ===
  it('crossChain=False (大文字混在) → true (case-sensitive、明示 false のみ false)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&crossChain=False'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.crossChain).toBe(true);
  });

  it('crossChain=FALSE → true (大文字も case-sensitive)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&crossChain=FALSE'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.crossChain).toBe(true);
  });

  it('crossChain= (空文字) → true (default 扱い)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&crossChain='));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.crossChain).toBe(true);
  });

  it('crossChain=0 / 1 / yes / no → 全て true (明示 false 文字列のみ false)', () => {
    for (const v of ['0', '1', 'yes', 'no', 'off', 'on']) {
      const r = parseTipParams(VALID_TO, search(`token=usdc&crossChain=${v}`));
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.params.crossChain).toBe(true);
    }
  });

  it('crossChain=false でも JPYC token は param 解析に影響しない (parser は token agnostic)', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=jpyc&chain=kaia&crossChain=false'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('jpyc');
      expect(r.params.chain).toBe('kaia');
      // crossChain は parser では token に関係なく解釈、Form/Generator 側で
      // JPYC のとき URL 出力をスキップする (= false でも壊れない)
      expect(r.params.crossChain).toBe(false);
    }
  });

  // === Tip 固有: gasless 必須なので非対応 chain は parse 時に reject ===
  it('usdc + ethereum → reject (Tip widget は gasless 必須、L1 は非対応)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&chain=ethereum'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/gasless mode 必須|tip widget 非対応/);
  });

  it('jpyc + base → reject (JPYC 非 deploy chain、hasDeployment で false)', () => {
    const r = parseTipParams(VALID_TO, search('token=jpyc&chain=base'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('対応していません');
  });

  it('jpyc + arbitrum / optimism / ethereum も同様に reject', () => {
    for (const chain of ['arbitrum', 'optimism', 'ethereum']) {
      const r = parseTipParams(VALID_TO, search(`token=jpyc&chain=${chain}`));
      expect(r.ok).toBe(false);
    }
  });

  // === Full field roundtrip ===
  it('全 field roundtrip: build (crossChain=false 含む) → parse で全 field 復元', () => {
    const built = buildTipPath({
      to: VALID_TO,
      token: 'usdc',
      chain: 'arbitrum',
      name: 'Carol',
      message: 'Tip me',
      color: '#abc123',
      presets: ['1', '5', '10'],
      thanks: 'Thanks!',
      thanksUrl: 'https://example.com/thanks',
      webhook: 'https://example.com/hook',
      crossChain: false,
    });
    expect(built).toContain('crossChain=false');
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params).toMatchObject({
        token: 'usdc',
        chain: 'arbitrum',
        name: 'Carol',
        message: 'Tip me',
        color: '#abc123',
        presets: ['1', '5', '10'],
        thanks: 'Thanks!',
        thanksUrl: 'https://example.com/thanks',
        webhook: 'https://example.com/hook',
        crossChain: false,
      });
    }
  });

  it('query param 順序非依存: crossChain=false が最後でも最初でも同じ', () => {
    const first = parseTipParams(VALID_TO, search('crossChain=false&token=usdc'));
    const last = parseTipParams(VALID_TO, search('token=usdc&crossChain=false'));
    expect(first.ok).toBe(true);
    expect(last.ok).toBe(true);
    if (first.ok && last.ok) {
      expect(first.params.crossChain).toBe(false);
      expect(last.params.crossChain).toBe(false);
    }
  });
});

describe('DEFAULT_TIP_PRESETS', () => {
  it('JPYC は 300 / 1000 / 3000 (最小 preset の実効手数料率が 5% 以下)', () => {
    expect(DEFAULT_TIP_PRESETS.jpyc).toEqual(['300', '1000', '3000']);
  });
  it('USDC は 5 / 20 / 50 (最小 preset の実効手数料率が 5% 以下)', () => {
    expect(DEFAULT_TIP_PRESETS.usdc).toEqual(['5', '20', '50']);
  });
});

describe('PayParams: split (multi-recipient C1)', () => {
  const A: `0x${string}` = '0x1111111111111111111111111111111111111111';
  const B: `0x${string}` = '0x2222222222222222222222222222222222222222';
  const C: `0x${string}` = '0x3333333333333333333333333333333333333333';

  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('split を含む URL を build → parse', () => {
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'customer',
      amount: '100',
      mode: 'gasless',
      split: [
        { to: B, percent: 30 },
        { to: C, percent: 20 },
      ],
    });
    expect(path).toContain('split=');
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.split).toEqual([
        { to: B, percent: 30 },
        { to: C, percent: 20 },
      ]);
    }
  });

  it('split sum >= 100 → エラー', () => {
    const r = parsePayParams(
      search(`to=${A}&token=usdc&split=${B}:60,${C}:40`),
    );
    expect(r.ok).toBe(false);
  });

  it('split entry が 4 件以上 → エラー (上限 3)', () => {
    const D: `0x${string}` = '0x4444444444444444444444444444444444444444';
    const E: `0x${string}` = '0x5555555555555555555555555555555555555555';
    const r = parsePayParams(
      search(
        `to=${A}&token=usdc&split=${B}:10,${C}:10,${D}:10,${E}:10`,
      ),
    );
    expect(r.ok).toBe(false);
  });

  it('split percent が 0 / 負 / 非整数 → エラー', () => {
    expect(
      parsePayParams(
        search(`to=${A}&token=usdc&split=${B}:0`),
      ).ok,
    ).toBe(false);
    expect(
      parsePayParams(
        search(`to=${A}&token=usdc&split=${B}:50.5`),
      ).ok,
    ).toBe(false);
    expect(
      parsePayParams(
        search(`to=${A}&token=usdc&split=${B}:-10`),
      ).ok,
    ).toBe(false);
  });

  it('split の宛先重複 → エラー', () => {
    const r = parsePayParams(
      search(`to=${A}&token=usdc&split=${B}:10,${B}:20`),
    );
    expect(r.ok).toBe(false);
  });

  it('split に主 to と同じアドレス → エラー', () => {
    const r = parsePayParams(
      search(`to=${A}&token=usdc&split=${A}:10`),
    );
    expect(r.ok).toBe(false);
  });

  it('split が不正な 0x → エラー', () => {
    const r = parsePayParams(
      search(`to=${A}&token=usdc&split=0xnope:10`),
    );
    expect(r.ok).toBe(false);
  });

  it('split を持たない URL は従来通り通る (split は undefined)', () => {
    const r = parsePayParams(
      search(`to=${A}&token=usdc&amount=10`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.split).toBeUndefined();
  });
});

describe('TipParams: thanks / thanksUrl / webhook', () => {
  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('thanks をビルドして parse できる', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      thanks: 'ありがとう！Discord 招待: ↓',
    });
    expect(path).toContain('thanks=');
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.thanks).toBe('ありがとう！Discord 招待: ↓');
  });

  it('thanks が長すぎたら 200 文字で切詰', () => {
    const long = 'あ'.repeat(300);
    const path = buildTipPath({ to: VALID_TO, token: 'jpyc', thanks: long });
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.thanks!.length).toBe(200);
  });

  it('thanksUrl は http/https のみ受理 (https 通過)', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      thanksUrl: 'https://discord.gg/abc',
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.thanksUrl).toBe('https://discord.gg/abc');
  });

  it('thanksUrl は javascript: スキームを拒否', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      thanksUrl: 'javascript:alert(1)',
    });
    expect(path).not.toContain('thanksUrl=');
  });

  it('thanksUrl は不正 URL を拒否', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      thanksUrl: 'not-a-url',
    });
    expect(path).not.toContain('thanksUrl=');
  });

  it('webhook も URL バリデーション同様', () => {
    const okPath = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      webhook: 'https://example.com/hook',
    });
    expect(okPath).toContain('webhook=');

    const badPath = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      webhook: 'ftp://nope/',
    });
    expect(badPath).not.toContain('webhook=');
  });

  it('parser 側でも http(s) 以外は除外', () => {
    const r = parseTipParams(
      VALID_TO,
      search(
        'token=jpyc&thanksUrl=javascript%3Aalert(1)&webhook=ftp%3A%2F%2Ffoo',
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.thanksUrl).toBeUndefined();
      expect(r.params.webhook).toBeUndefined();
    }
  });
});

describe('parseTipParams: chain パラメタ (Phase 1 multi-chain)', () => {
  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('chain 省略 → token の default (usdc=base, jpyc=polygon)', () => {
    const u = parseTipParams(VALID_TO, search('token=usdc'));
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.params.chain).toBe('base');
    const j = parseTipParams(VALID_TO, search('token=jpyc'));
    expect(j.ok).toBe(true);
    if (j.ok) expect(j.params.chain).toBe('polygon');
  });

  it('chain=optimism + token=usdc → OK (deployment あり)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&chain=optimism'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.chain).toBe('optimism');
  });

  it('chain=avalanche → エラー (slug invalid)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&chain=avalanche'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('chain');
  });

  it('chain="" (空文字) → default に倒す', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&chain='));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.chain).toBe('base');
  });

  it('chain=arbitrum + token=jpyc → エラー (deployment 不在)', () => {
    const r = parseTipParams(VALID_TO, search('token=jpyc&chain=arbitrum'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('jpyc');
  });

  it('chain=ethereum + token=usdc → エラー (tip widget は gasless 必須、Ethereum L1 は gasless 非対応)', () => {
    const r = parseTipParams(VALID_TO, search('token=usdc&chain=ethereum'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('usdc');
      expect(r.error).toContain('ethereum');
      expect(r.error).toContain('tip');
    }
  });

  it('roundtrip: build (chain=optimism) → parse', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'usdc',
      chain: 'optimism',
      name: 'Carol',
    });
    expect(path).toContain('chain=optimism');
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.chain).toBe('optimism');
      expect(r.params.name).toBe('Carol');
    }
  });

  it('build: default chain (usdc=base) は URL に出さない', () => {
    const path = buildTipPath({ to: VALID_TO, token: 'usdc', chain: 'base' });
    expect(path).not.toContain('chain=');
  });
});

describe('parseSplitDrafts (QrGenerator UI 用 draft validator)', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';
  const B: Address = '0x2222222222222222222222222222222222222222';
  const C: Address = '0x3333333333333333333333333333333333333333';

  it('空配列 → entries=[], sum=0, error=null', () => {
    expect(parseSplitDrafts([], A)).toEqual({ entries: [], sum: 0, error: null });
  });

  it('全 draft が valid → entries に SplitEntry[] / sum 集計', () => {
    const r = parseSplitDrafts(
      [
        { address: B, percent: '30' },
        { address: C, percent: '20' },
      ],
      A,
    );
    expect(r.error).toBe(null);
    expect(r.sum).toBe(50);
    expect(r.entries).toEqual([
      { to: B, percent: 30 },
      { to: C, percent: 20 },
    ]);
  });

  it('空欄ペア (address/percent 両方 "") は無視', () => {
    const r = parseSplitDrafts(
      [
        { address: B, percent: '30' },
        { address: '', percent: '' },
        { address: C, percent: '20' },
      ],
      A,
    );
    expect(r.error).toBe(null);
    expect(r.entries).toHaveLength(2);
  });

  it('不正アドレス → error=addr (entries=null)', () => {
    const r = parseSplitDrafts([{ address: 'nope', percent: '30' }], A);
    expect(r.error).toBe('addr');
    expect(r.entries).toBeNull();
  });

  it('% が非整数/範囲外 → error=pct', () => {
    expect(
      parseSplitDrafts([{ address: B, percent: '30.5' }], A).error,
    ).toBe('pct');
    expect(
      parseSplitDrafts([{ address: B, percent: '0' }], A).error,
    ).toBe('pct');
    expect(
      parseSplitDrafts([{ address: B, percent: '100' }], A).error,
    ).toBe('pct');
  });

  it('合計 % >= 100 → error=sum', () => {
    const r = parseSplitDrafts(
      [
        { address: B, percent: '60' },
        { address: C, percent: '40' },
      ],
      A,
    );
    expect(r.error).toBe('sum');
  });

  it('主 to との重複 → error=dup', () => {
    expect(
      parseSplitDrafts([{ address: A, percent: '30' }], A).error,
    ).toBe('dup');
  });

  it('split 内重複 → error=dup', () => {
    const r = parseSplitDrafts(
      [
        { address: B, percent: '30' },
        { address: B, percent: '20' },
      ],
      A,
    );
    expect(r.error).toBe('dup');
  });

  it('primary=null でも主 to 重複チェックはスキップ (split 内重複は依然検出)', () => {
    const r = parseSplitDrafts(
      [
        { address: A, percent: '30' },
        { address: A, percent: '20' },
      ],
      null,
    );
    expect(r.error).toBe('dup');
  });

  it('小文字大文字混じりでも重複検出 (toLowerCase で比較)', () => {
    const Blower = B.toLowerCase() as Address;
    const r = parseSplitDrafts(
      [
        { address: B, percent: '30' },
        { address: Blower, percent: '20' },
      ],
      A,
    );
    expect(r.error).toBe('dup');
  });

  it('複数エラーがある場合は最初に出会ったものを返す', () => {
    const r = parseSplitDrafts(
      [
        { address: 'bad', percent: '30' },
        { address: B, percent: 'xyz' },
      ],
      A,
    );
    expect(r.error).toBe('addr');
  });
});

describe('TipParams: Unicode + 制御文字 / URL エンコーディングのエッジケース', () => {
  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('絵文字を含む名前は保持される (4-byte UTF-16 代理ペア)', () => {
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      name: '🎨アーティスト🎨',
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.name).toBe('🎨アーティスト🎨');
  });

  it('改行・タブ・C0 制御文字は除去 (URL クエリへの注入防止)', () => {
    const dirty = 'Alice\n\r\t\x00\x07\x1f\x7f';
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      name: dirty,
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    expect(sp.get('name')).toBe('Alice');
  });

  it('CJK 全角空白は通常文字として保持される', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=jpyc&name=' + encodeURIComponent('A　B')),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.name).toBe('A　B');
  });

  it('preset の前後空白は trim、ゼロ埋め "001" は許容', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=jpyc&preset=' + encodeURIComponent(' 001 , 002 ')),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.presets).toEqual(['001', '002']);
  });

  it('webhook URL がポート + パス + クエリ込みでも保持', () => {
    const url = 'https://hooks.example.com:8443/webhooks/tip?id=42';
    const path = buildTipPath({
      to: VALID_TO,
      token: 'jpyc',
      webhook: url,
    });
    const sp = new URLSearchParams(path.split('?')[1]);
    const r = parseTipParams(VALID_TO, sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      // URL クラス経由で末尾に / が付与されない場合あり (toString の仕様)
      expect(r.params.webhook).toContain('hooks.example.com:8443');
      expect(r.params.webhook).toContain('id=42');
    }
  });

  it('color のチェックサムは緩く: #ABC は 3-digit なので拒否 (#rrggbb のみ受理)', () => {
    const r = parseTipParams(
      VALID_TO,
      search('token=jpyc&color=' + encodeURIComponent('#ABC')),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.color).toBeUndefined();
  });
});

describe('PayParams: 不正クエリ + roundtrip 完全性', () => {
  function search(query: string) {
    return new URLSearchParams(query);
  }

  it('build → parse roundtrip ですべての params が一致 (split 含む)', () => {
    const A: `0x${string}` = '0x1111111111111111111111111111111111111111';
    const B: `0x${string}` = '0x2222222222222222222222222222222222222222';
    const built = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'customer',
      amount: '12.345678',
      mode: 'gasless',
      split: [{ to: B, percent: 25 }],
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(A);
      expect(r.params.token).toBe('usdc');
      expect(r.params.amount).toBe('12.345678');
      expect(r.params.mode).toBe('gasless');
      expect(r.params.split).toEqual([{ to: B, percent: 25 }]);
    }
  });

  it('split が空配列なら build で URL に出さない (parse で undefined)', () => {
    const A: `0x${string}` = '0x1111111111111111111111111111111111111111';
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'customer',
      mode: 'gasless',
      split: [],
    });
    expect(path).not.toContain('split=');
  });

  it('amount の小数点表記は保持 (parseUnits 側で wei 化される想定)', () => {
    const A: `0x${string}` = '0x1111111111111111111111111111111111111111';
    const r = parsePayParams(
      search(`to=${A}&token=jpyc&amount=0.000001`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.amount).toBe('0.000001');
  });
});

// ---------------------------------------------------------------------------
// searchParamsFromNext: Next.js route searchParams → SearchParamsLike 橋渡し
// ---------------------------------------------------------------------------
describe('searchParamsFromNext', () => {
  const VALID_TO_LOC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  it('string value をそのまま返す', () => {
    const sp = searchParamsFromNext({ token: 'usdc', to: VALID_TO_LOC });
    expect(sp.get('token')).toBe('usdc');
    expect(sp.get('to')).toBe(VALID_TO_LOC);
  });

  it('undefined → null を返す (省略 param)', () => {
    const sp = searchParamsFromNext({ token: 'usdc' });
    expect(sp.get('missing')).toBeNull();
    expect(sp.get('to')).toBeNull();
  });

  it('Array (同一 param が複数指定された場合) → 先頭値を返す', () => {
    // URL ?gas=customer&gas=merchant の Next.js 形式は { gas: ['customer', 'merchant'] }
    const sp = searchParamsFromNext({
      gas: ['customer', 'merchant'],
      token: 'usdc',
    });
    expect(sp.get('gas')).toBe('customer');
    expect(sp.get('token')).toBe('usdc');
  });

  it('Array が空のときは null を返す (safe default)', () => {
    const sp = searchParamsFromNext({ gas: [] });
    expect(sp.get('gas')).toBeNull();
  });

  it('parsePayParams と組合せて Array 値の URL も parse できる', () => {
    // Next.js が array で渡してきても先頭値が使われる
    const sp = searchParamsFromNext({
      to: [VALID_TO_LOC, '0xnoise'],
      token: 'usdc',
      mode: ['standard', 'gasless'],
    });
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(VALID_TO_LOC);
      expect(r.params.mode).toBe('standard');
    }
  });
});

// ---------------------------------------------------------------------------
// PayMode + GasMode + mode roundtrip 全網羅 (mode と gas の組合せ依存)
// ---------------------------------------------------------------------------
describe('PayMode / GasMode 組合せ roundtrip + URL 形状', () => {
  const A: Address = '0x1111111111111111111111111111111111111111';

  it('mode=gasless + gas=customer (default): URL に mode / gas 共に出ない', () => {
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'customer',
      mode: 'gasless',
    });
    expect(path).not.toContain('mode=');
    expect(path).not.toContain('gas=');
  });

  it('mode=gasless + gas=merchant: gas=merchant のみ出る (mode は default)', () => {
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'merchant',
      mode: 'gasless',
    });
    expect(path).not.toContain('mode=');
    expect(path).toContain('gas=merchant');
  });

  it('mode=standard + gas=customer: mode=standard のみ出る (gas は standard では無効化)', () => {
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'customer',
      mode: 'standard',
    });
    expect(path).toContain('mode=standard');
    expect(path).not.toContain('gas=');
  });

  it('mode=standard + gas=merchant: mode=standard のみ出る (gas は省略 — standard では irrelevant)', () => {
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'merchant',
      mode: 'standard',
    });
    expect(path).toContain('mode=standard');
    expect(path).not.toContain('gas=');
  });

  it('roundtrip: build (mode=standard, gas=merchant) → parse で mode=standard, gas=customer (default)', () => {
    // build 時に gas=merchant は出ないため parse 側では default customer に戻る
    const path = buildPayPath({
      to: A,
      token: 'usdc',
      gas: 'merchant',
      mode: 'standard',
    });
    const r = parsePayParams(new URLSearchParams(path.split('?')[1]));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.mode).toBe('standard');
      expect(r.params.gas).toBe('customer');
    }
  });

  it('legacy alias の roundtrip 不可逆性: parse mode=direct → standard、build standard → URL に mode=standard', () => {
    const r = parsePayParams(
      new URLSearchParams(`to=${A}&token=usdc&mode=direct`),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.params.mode).toBe('standard');
    // rebuild → mode=standard (mode=direct は復元しない、新名で書出)
    const rebuilt = buildPayPath(r.params);
    expect(rebuilt).toContain('mode=standard');
    expect(rebuilt).not.toContain('mode=direct');
  });
});

// ---------------------------------------------------------------------------
// /checkout の mode 同期 (lib/url の mode 引数を CheckoutParams が共有)
// ---------------------------------------------------------------------------
describe('CheckoutParams mode 同期', () => {
  const MERCHANT_LOC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

  it('checkout build: mode 未指定で URL に mode は出ない (default gasless)', async () => {
    const { buildCheckoutPath } = await import('@/lib/url');
    const path = buildCheckoutPath({
      to: MERCHANT_LOC,
      token: 'usdc',
      gas: 'customer',
      items: [{ name: 'A', qty: 1, price: '10' }],
    });
    expect(path).not.toContain('mode=');
  });

  it('checkout build: mode=standard で URL に mode=standard が出る', async () => {
    const { buildCheckoutPath } = await import('@/lib/url');
    const path = buildCheckoutPath({
      to: MERCHANT_LOC,
      token: 'usdc',
      gas: 'customer',
      mode: 'standard',
      items: [{ name: 'A', qty: 1, price: '10' }],
    });
    expect(path).toContain('mode=standard');
  });

  it('checkout parse: mode=direct は legacy alias で standard に正規化', async () => {
    const { parseCheckoutParams } = await import('@/lib/url');
    const r = parseCheckoutParams(
      new URLSearchParams(
        `to=${MERCHANT_LOC}&token=usdc&items=A:1:10&mode=direct`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('standard');
  });

  it('checkout parse: 不明 mode は default gasless に倒す (UI を壊さない設計)', async () => {
    const { parseCheckoutParams } = await import('@/lib/url');
    const r = parseCheckoutParams(
      new URLSearchParams(
        `to=${MERCHANT_LOC}&token=usdc&items=A:1:10&mode=meta`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('gasless');
  });

  it('checkout build: mode=standard + gas=merchant → URL に mode のみ (gas は出ない)', async () => {
    const { buildCheckoutPath } = await import('@/lib/url');
    const path = buildCheckoutPath({
      to: MERCHANT_LOC,
      token: 'usdc',
      gas: 'merchant',
      mode: 'standard',
      items: [{ name: 'A', qty: 1, price: '10' }],
    });
    expect(path).toContain('mode=standard');
    expect(path).not.toContain('gas=');
  });
});

// ---------------------------------------------------------------------------
// PayParams: crossChain flag (phase 2 cross-chain receive)
// ---------------------------------------------------------------------------
describe('PayParams: crossChain (cross-chain receive)', () => {
  const VALID_TO_CC: Address = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

  it('build: crossChain 未指定 / true は URL に出さない (default ON、旧 QR 互換)', async () => {
    const { buildPayPath } = await import('@/lib/url');
    const a = buildPayPath({
      to: VALID_TO_CC,
      token: 'usdc',
      gas: 'customer',
      mode: 'gasless',
      amount: '5',
    });
    expect(a).not.toContain('crossChain');
    const b = buildPayPath({
      to: VALID_TO_CC,
      token: 'usdc',
      gas: 'customer',
      mode: 'gasless',
      amount: '5',
      crossChain: true,
    });
    expect(b).not.toContain('crossChain');
  });

  it('build: crossChain=false で URL に crossChain=false が出る', async () => {
    const { buildPayPath } = await import('@/lib/url');
    const path = buildPayPath({
      to: VALID_TO_CC,
      token: 'usdc',
      gas: 'customer',
      mode: 'gasless',
      amount: '5',
      crossChain: false,
    });
    expect(path).toContain('crossChain=false');
  });

  it('parse: crossChain 未指定 → 既定 true', async () => {
    const { parsePayParams } = await import('@/lib/url');
    const r = parsePayParams(
      new URLSearchParams(`to=${VALID_TO_CC}&token=usdc&amount=5`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.crossChain).toBe(true);
  });

  it('parse: crossChain=false → false', async () => {
    const { parsePayParams } = await import('@/lib/url');
    const r = parsePayParams(
      new URLSearchParams(
        `to=${VALID_TO_CC}&token=usdc&amount=5&crossChain=false`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.crossChain).toBe(false);
  });

  it('parse: crossChain=true / 不明値 → true (default fallback)', async () => {
    const { parsePayParams } = await import('@/lib/url');
    const r1 = parsePayParams(
      new URLSearchParams(`to=${VALID_TO_CC}&token=usdc&crossChain=true`),
    );
    const r2 = parsePayParams(
      new URLSearchParams(`to=${VALID_TO_CC}&token=usdc&crossChain=meta`),
    );
    expect(r1.ok && r1.params.crossChain).toBe(true);
    expect(r2.ok && r2.params.crossChain).toBe(true);
  });

  it('crossChain は invalid 判定で empty 扱いされない (空 QR 誤検知防止)', async () => {
    const { parsePayParams } = await import('@/lib/url');
    // to なし + crossChain だけ → invalid (errorKind: 'invalid', not 'empty')
    const r = parsePayParams(new URLSearchParams('crossChain=false'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorKind).toBe('invalid');
  });

  it('roundtrip: build → parse で crossChain が保存される', async () => {
    const { buildPayPath, parsePayParams } = await import('@/lib/url');
    const path = buildPayPath({
      to: VALID_TO_CC,
      token: 'usdc',
      gas: 'customer',
      mode: 'gasless',
      amount: '5',
      crossChain: false,
    });
    const sp = new URLSearchParams(path.replace('/pay?', ''));
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.crossChain).toBe(false);
  });
});
