import { describe, it, expect } from 'vitest';
import { buildPayPath, buildPayUrl, parsePayParams } from '@/lib/url';

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
