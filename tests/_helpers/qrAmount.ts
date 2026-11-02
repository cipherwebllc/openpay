import { screen } from '@testing-library/react';

// 決済QR の金額欄を探す。空のときに出していた淡い例の額 (placeholder: JPYC は 1,000・USDC は 10.00) を
// 2026-11-03 にやめたので、欄の名前 (見出しと同じ「請求金額 (JPYC)」) で探す。名前に通貨が入るので、
// 以前の placeholder と同じく通貨の切り替えも確かめられる。値引きを開くと「値引き前の金額 (JPYC)」になる。
// 見出しの section も aria-labelledby で同じ名前を持つので、input に絞る。
type AmountSymbol = 'JPYC' | 'USDC';

const amountName = (symbol: AmountSymbol) =>
  new RegExp(`^(請求金額|値引き前の金額|Amount|Amount before discount) \\(${symbol}\\)$`);

export function qrAmountInput(symbol: AmountSymbol = 'JPYC'): HTMLInputElement {
  return screen.getByLabelText(amountName(symbol), { selector: 'input' }) as HTMLInputElement;
}

export async function findQrAmountInput(symbol: AmountSymbol = 'JPYC'): Promise<HTMLInputElement> {
  return (await screen.findByLabelText(amountName(symbol), { selector: 'input' })) as HTMLInputElement;
}
