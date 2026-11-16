// QrPreviewModal の screenQrValue (画面の QR にだけ描く値 = 会計ごとの印つきの URL):
//   - 画面の QR は screenQrValue・リンクの表示と互換 QR は今までどおり。
//   - 印刷・保存は画面の QR の <svg> をそのまま使うので、そのあいだだけ qrValue (bill key なし) で描く。
//   - screenQrValue を渡さない画面 (お店負担の QR・載せない QR) は、今までと同じ (渡された handler をそのまま呼ぶ)。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';

// QR に渡す値を data 属性で読む。
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, size }: { value: string; size: number }) => <svg data-size={size} data-value={value} />,
}));

import { QrPreviewModal } from '@/components/QrPreviewModal';

const PLAIN = 'https://test.local/pay?to=0xabc&token=jpyc&gas=merchant&amount=500';
const SCREEN = `${PLAIN}&bk=Zm9vYmFyYmF6cXV4MTIzNA`;
const SCREEN2 = `${PLAIN}&bk=a-b_c-d_e-f_g-h_0123Zz`;
const LABELS = {
  title: '決済用 QR コード',
  close: '閉じる',
  eyebrow: 'OpenPay',
  print: '印刷',
  copy: 'リンクをコピー',
  copied: 'コピーしました',
  downloadSvg: 'SVG保存',
  downloadPng: 'PNG保存',
  showUrl: 'リンクを表示',
};

type Props = Parameters<typeof QrPreviewModal>[0];
function modalProps(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    onClose: vi.fn(),
    labels: LABELS,
    qrValue: PLAIN,
    screenQrValue: SCREEN,
    qrRef: createRef<HTMLDivElement>(),
    storeName: 'Kanda Coffee',
    amountText: '500 JPYC',
    chainText: 'JPYC · Polygon',
    copied: false,
    onCopy: vi.fn(),
    onPrint: vi.fn(),
    onDownloadSvg: vi.fn(),
    onDownloadPng: vi.fn(),
    ...overrides,
  };
}
const mainQr = () => document.querySelector('svg[data-size="340"]')!.getAttribute('data-value');
const button = (name: string) => screen.getByRole('button', { name });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('QrPreviewModal — 画面の QR だけの値 (screenQrValue)', () => {
  it('画面の QR は screenQrValue。リンクの表示は qrValue のまま・互換 QR (EIP-681) は変わらない', () => {
    render(
      <QrPreviewModal
        {...modalProps({
          eip681: {
            uri: 'ethereum:0xtoken@137/transfer?address=0xabc&uint256=5e20', copied: false, onCopy: vi.fn(),
            title: '互換 QR', badge: '上級者向け', description: '説明', copy: 'コピー', copiedLabel: 'コピー済み',
          },
        })}
      />,
    );
    expect(mainQr()).toBe(SCREEN);
    expect(screen.getByText(PLAIN)).toBeInTheDocument();
    expect(screen.queryByText(SCREEN)).toBeNull();
    expect(document.querySelector('svg[data-size="180"]')!.getAttribute('data-value')).toMatch(/^ethereum:/);
    // bill key が出るのは、画面の QR の値の 1 か所だけ。
    expect(document.body.innerHTML.match(/bk=/g)).toHaveLength(1);
  });

  it('screenQrValue を渡さなければ、画面の QR は qrValue (今までと同じ)。印刷・保存は渡された関数をそのまま 1 回呼ぶだけ', () => {
    const props = modalProps({ screenQrValue: undefined });
    render(<QrPreviewModal {...props} />);
    expect(mainQr()).toBe(PLAIN);
    fireEvent.click(button('印刷'));
    fireEvent.click(button('SVG保存'));
    fireEvent.click(button('PNG保存'));
    expect(props.onPrint).toHaveBeenCalledTimes(1);
    expect(props.onDownloadSvg).toHaveBeenCalledTimes(1);
    expect(props.onDownloadPng).toHaveBeenCalledTimes(1);
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(mainQr()).toBe(PLAIN);
  });

  it('SVG 保存・PNG 保存: 保存の関数が <svg> を読む瞬間は bill key なし。終わったら (保存が throw しても) 画面は bill key つきに戻る', () => {
    const seen: (string | null)[] = [];
    const props = modalProps({
      onDownloadSvg: vi.fn(() => { seen.push(mainQr()); }),
      onDownloadPng: vi.fn(() => { seen.push(mainQr()); throw new Error('canvas failed'); }),
    });
    render(<QrPreviewModal {...props} />);
    fireEvent.click(button('SVG保存'));
    expect(seen).toEqual([PLAIN]);
    expect(mainQr()).toBe(SCREEN);
    // 保存の失敗は今までどおり呼び出し元へ届く (握りつぶさない) が、画面の QR は戻す。
    const onError = vi.fn((event: ErrorEvent) => event.preventDefault());
    window.addEventListener('error', onError);
    fireEvent.click(button('PNG保存'));
    window.removeEventListener('error', onError);
    expect(seen).toEqual([PLAIN, PLAIN]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(mainQr()).toBe(SCREEN);
  });

  it('印刷ボタン: 印刷が始まる瞬間は bill key なし。印刷が終わったら (afterprint) bill key つきに戻る', () => {
    const seen: (string | null)[] = [];
    const props = modalProps({ onPrint: vi.fn(() => { seen.push(mainQr()); }) });
    render(<QrPreviewModal {...props} />);
    fireEvent.click(button('印刷'));
    expect(seen).toEqual([PLAIN]);
    // 印刷の画面が閉じるまでは bill key なしのまま (印刷の途中で戻さない)。
    expect(mainQr()).toBe(PLAIN);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(mainQr()).toBe(SCREEN);
  });

  it('ブラウザのメニュー・ショートカットからの印刷 (beforeprint / afterprint) でも同じ', () => {
    render(<QrPreviewModal {...modalProps()} />);
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    expect(mainQr()).toBe(PLAIN);
    expect(document.body.innerHTML).not.toMatch(/bk=/);
    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(mainQr()).toBe(SCREEN);
  });

  it('印刷の後に QR を出し直したら (新しい bill key)、afterprint が来ていなくても新しい bill key の QR を描く', () => {
    const { rerender } = render(<QrPreviewModal {...modalProps()} />);
    fireEvent.click(button('印刷'));
    expect(mainQr()).toBe(PLAIN);
    rerender(<QrPreviewModal {...modalProps({ screenQrValue: SCREEN2 })} />);
    expect(mainQr()).toBe(SCREEN2);
  });

  it('閉じている間・外した後は、印刷の event を聞かない', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const printEvents = (spy: typeof add | typeof remove) =>
      spy.mock.calls.map(([name]) => name).filter((name) => name === 'beforeprint' || name === 'afterprint');
    const { rerender, unmount } = render(<QrPreviewModal {...modalProps({ open: false })} />);
    expect(printEvents(add)).toEqual([]);
    rerender(<QrPreviewModal {...modalProps()} />);
    expect(printEvents(add)).toEqual(['beforeprint', 'afterprint']);
    unmount();
    expect(printEvents(remove)).toEqual(['beforeprint', 'afterprint']);
    // screenQrValue の無い画面は、開いていても聞かない。
    add.mockClear();
    render(<QrPreviewModal {...modalProps({ screenQrValue: undefined })} />);
    expect(printEvents(add)).toEqual([]);
  });

  it('印刷・保存の無い画面 (レジ) では、ボタンを足さない', () => {
    render(<QrPreviewModal {...modalProps({ onPrint: undefined, onDownloadSvg: undefined, onDownloadPng: undefined })} />);
    expect(mainQr()).toBe(SCREEN);
    expect(screen.queryByRole('button', { name: '印刷' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'SVG保存' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'PNG保存' })).toBeNull();
  });
});
