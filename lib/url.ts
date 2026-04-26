// /pay クエリ仕様:
//   to     (必須, 0x)
//   token  ("jpyc" | "usdc")
//   fee    ("include" | "exclude")           ※ mode=direct では無視
//   amount (任意, 人間可読 — 据え置き QR では省略)
//   mode   ("gasless" | "direct", 省略時 gasless) ※ direct のときのみ URL に出力
import { getAddress, isAddress } from 'viem';
import type { Address } from 'viem';
import type { FeeMode } from './fee';
import { isValidTokenSymbol, type TokenSymbol } from './tokens';

export type PayMode = 'gasless' | 'direct';

export type PayParams = {
  to: Address;
  token: TokenSymbol;
  fee: FeeMode;
  amount?: string;
  mode: PayMode;
};

export function buildPayPath(params: PayParams): string {
  const sp = new URLSearchParams();
  sp.set('to', params.to);
  sp.set('token', params.token);
  sp.set('fee', params.fee);
  if (params.amount && params.amount.length > 0) {
    sp.set('amount', params.amount);
  }
  // gasless は既定値なので URL に出さず、旧 QR との互換性を保つ。
  if (params.mode === 'direct') {
    sp.set('mode', 'direct');
  }
  return `/pay?${sp.toString()}`;
}

export function buildPayUrl(origin: string, params: PayParams): string {
  return `${origin}${buildPayPath(params)}`;
}

export type ParsedPayParams =
  | { ok: true; params: PayParams }
  | { ok: false; error: string };

/** URLSearchParams / Next の ReadonlyURLSearchParams どちらも構造的に受け取れる */
type SearchParamsLike = { get(name: string): string | null };

export function parsePayParams(searchParams: SearchParamsLike): ParsedPayParams {
  const to = searchParams.get('to');
  const token = searchParams.get('token');
  const fee = searchParams.get('fee');
  const amount = searchParams.get('amount');
  const mode = searchParams.get('mode');

  if (!to) return { ok: false, error: '宛先アドレス (to) が指定されていません' };
  if (!isAddress(to)) return { ok: false, error: '宛先アドレス (to) が不正です' };
  if (!token || !isValidTokenSymbol(token)) {
    return { ok: false, error: 'token は jpyc または usdc を指定してください' };
  }
  if (fee !== 'include' && fee !== 'exclude') {
    return { ok: false, error: 'fee は include または exclude を指定してください' };
  }
  if (mode !== null && mode !== 'gasless' && mode !== 'direct') {
    return { ok: false, error: 'mode は gasless または direct を指定してください' };
  }

  return {
    ok: true,
    params: {
      to: getAddress(to),
      token,
      fee,
      amount: amount && amount.length > 0 ? amount : undefined,
      mode: mode === 'direct' ? 'direct' : 'gasless',
    },
  };
}
