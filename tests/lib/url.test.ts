import { describe, it, expect } from 'vitest';
import {
  buildPayPath,
  buildPayUrl,
  parsePayParams,
  buildTipPath,
  buildTipUrl,
  parseTipParams,
  DEFAULT_TIP_PRESETS,
} from '@/lib/url';

// USDC (Base) のアドレスは checksum 既知のため、テストの roundtrip が安定する。
const VALID_TO = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

describe('buildPayPath', () => {
  it('amount を含めてビルド (mode=gasless は URL に出さない)', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      fee: 'include',
      amount: '10.5',
      mode: 'gasless',
    });
    expect(path).toBe(
      `/pay?to=${VALID_TO}&token=usdc&fee=include&amount=10.5`,
    );
    expect(path).not.toContain('mode=');
  });

  it('amount を省略してビルド', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'jpyc',
      fee: 'exclude',
      mode: 'gasless',
    });
    expect(path).toBe(`/pay?to=${VALID_TO}&token=jpyc&fee=exclude`);
    expect(path).not.toContain('amount');
  });

  it('amount=空文字列 は省略されたものとみなす', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      fee: 'include',
      amount: '',
      mode: 'gasless',
    });
    expect(path).not.toContain('amount');
  });

  it('mode=direct のときだけ URL に mode=direct を出す', () => {
    const path = buildPayPath({
      to: VALID_TO,
      token: 'jpyc',
      fee: 'include',
      amount: '1000',
      mode: 'direct',
    });
    expect(path).toContain('mode=direct');
  });
});

describe('buildPayUrl', () => {
  it('origin を前置する', () => {
    const url = buildPayUrl('https://openpay.example.com', {
      to: VALID_TO,
      token: 'usdc',
      fee: 'include',
      amount: '5',
      mode: 'gasless',
    });
    expect(url).toBe(
      `https://openpay.example.com/pay?to=${VALID_TO}&token=usdc&fee=include&amount=5`,
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
        `to=${VALID_TO}&token=usdc&fee=include&amount=10`,
      ),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.token).toBe('usdc');
      expect(r.params.fee).toBe('include');
      expect(r.params.amount).toBe('10');
      expect(r.params.mode).toBe('gasless');
    }
  });

  it('mode=direct を読み取る', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&fee=include&mode=direct`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('direct');
  });

  it('mode=gasless を明示しても受け入れる', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&fee=include&mode=gasless`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('gasless');
  });

  it('mode が unsupported → エラー', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=usdc&fee=include&mode=meta`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('mode');
  });

  it('to が無い → エラー', () => {
    const r = parsePayParams(search('token=usdc&fee=include'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('to');
  });

  it('to がアドレス形式でない → エラー', () => {
    const r = parsePayParams(
      search('to=0xnotanaddress&token=usdc&fee=include'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('不正');
  });

  it('token が無い → エラー', () => {
    const r = parsePayParams(search(`to=${VALID_TO}&fee=include`));
    expect(r.ok).toBe(false);
  });

  it('token が unsupported → エラー', () => {
    const r = parsePayParams(
      search(`to=${VALID_TO}&token=eth&fee=include`),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('jpyc');
  });

  it('fee が無い / 不正 → エラー', () => {
    expect(
      parsePayParams(search(`to=${VALID_TO}&token=usdc`)).ok,
    ).toBe(false);
    expect(
      parsePayParams(
        search(`to=${VALID_TO}&token=usdc&fee=foo`),
      ).ok,
    ).toBe(false);
  });

  it('小文字アドレスは checksum 正規化されて、元の checksum 文字列と一致する', () => {
    const lower = VALID_TO.toLowerCase() as `0x${string}`;
    const r = parsePayParams(
      search(`to=${lower}&token=jpyc&fee=exclude`),
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
      search(`to=${VALID_TO}&token=usdc&fee=include&amount=`),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.amount).toBeUndefined();
  });

  it('未知パラメータは無視', () => {
    const r = parsePayParams(
      search(
        `to=${VALID_TO}&token=usdc&fee=include&xss=<script>`,
      ),
    );
    expect(r.ok).toBe(true);
  });

  it('roundtrip: build → parse で同じ値 (gasless)', () => {
    const built = buildPayPath({
      to: VALID_TO,
      token: 'usdc',
      fee: 'include',
      amount: '12.34',
      mode: 'gasless',
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.to).toBe(VALID_TO);
      expect(r.params.token).toBe('usdc');
      expect(r.params.fee).toBe('include');
      expect(r.params.amount).toBe('12.34');
      expect(r.params.mode).toBe('gasless');
    }
  });

  it('roundtrip: build → parse で同じ値 (direct)', () => {
    const built = buildPayPath({
      to: VALID_TO,
      token: 'jpyc',
      fee: 'include',
      amount: '1000',
      mode: 'direct',
    });
    const sp = new URLSearchParams(built.split('?')[1]);
    const r = parsePayParams(sp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.mode).toBe('direct');
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
});

describe('DEFAULT_TIP_PRESETS', () => {
  it('JPYC は 100 / 500 / 1000', () => {
    expect(DEFAULT_TIP_PRESETS.jpyc).toEqual(['100', '500', '1000']);
  });
  it('USDC は 1 / 5 / 10', () => {
    expect(DEFAULT_TIP_PRESETS.usdc).toEqual(['1', '5', '10']);
  });
});
