import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithIntl } from '../_helpers/i18n';

// F-8 PR-20 (TipEmbedGenerator をセクション単位の component に分ける) の網。期待値はすべて分割前の
// component (origin/main 4d988117) で採取したもの。分割に合わせて採り直さない — hash や生成物が変わったら
// DOM か出力が変わったので、分割の方を直す。固定するもの:
//   - 生成物の完全一致: Tip URL・「新しいタブ」の href・X シェアの URL・iframe / ボタンの埋め込みコード・
//     クリップボードに書く値・QR に渡す URL・プレビューの TipForm に渡す params (5 通りの設定)
//   - 全 DOM の hash (新規・入力済み・公開の各状態 (コピー済み・QR・iframe・ボタン)・受け取りの欄と設定シート・
//     表示のカード (開発者向け設定を開いた状態)・長い URL (QR を省く)・応援メッセージの受信箱 5 状態)
//   - 子 component に分けても入力欄・折りたたみを作り直さないこと (node の同一性と focus) と、プレビューを
//     作り直す条件 (通貨・チェーン・金額が変わったときだけ) が変わらないこと
//   - 表示中に受取先・金額・通貨を変えた後のコピーと QR が、変えた後の URL / コードを使うこと (古い値を握った
//     callback を検出する。この 1 本の期待値も分割前の component (cca67e89~1 の TipEmbedGenerator.tsx) で採取)
// 振る舞いの細部 (URL の各 param・永続化・ENS・a11y 等) は TipEmbedGenerator.test.tsx が固定している。

const VALID = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const OTHER = '0x000000000000000000000000000000000000dEaD';
const KEY = 'openpay:tip-settings:v2';
const h = vi.hoisted(() => ({
  enableTipMessage: false,
  connected: undefined as string | undefined,
  resolve: {} as Record<string, string>,
  signedIn: false,
  previewMounts: 0,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableTipMessage() {
        return h.enableTipMessage;
      },
    },
  };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.connected, isConnected: h.connected !== undefined }),
}));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: (input: string) => {
    const address = h.resolve[input.trim().toLowerCase()];
    return { data: address ? { address } : null, isFetching: false, error: null };
  },
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.signedIn,
    isSigningIn: false,
    signInError: null,
    signIn: vi.fn(),
  }),
}));
// 本物の TipForm (wagmi の多数の hook) は持ち込まず、受け取った params をすべて DOM に書き出す (→ DOM の hash に入る)。
// mount の回数は、プレビューを作り直す条件 (key) が分割で変わらないことの確認に使う。
vi.mock('@/components/TipForm', async () => {
  const { useEffect } = await import('react');
  return {
    TipForm: ({ params, preview }: { params: unknown; preview?: boolean }) => {
      useEffect(() => {
        h.previewMounts += 1;
      }, []);
      return (
        <pre data-testid="tip-preview-params" data-preview={String(preview)}>
          {JSON.stringify(params)}
        </pre>
      );
    },
  };
});

import { TipEmbedGenerator } from '@/components/TipEmbedGenerator';
import { chainForSlug } from '@/lib/chains';

// 任意の欄を全部使った設定 (HTML の実体参照が要る名前・ラベル付きの金額・お礼の文とリンク・Kaia)。
const RICH = {
  receiver: VALID,
  token: 'jpyc',
  chain: 'kaia',
  name: 'A&B "Tip" <Shop>',
  message: '応援ありがとう\n2 行目',
  color: '#FF0080',
  theme: 'night',
  presets: { jpyc: ['500', '1500', '5000'], usdc: ['5', '20', '50'] },
  presetLabels: { jpyc: ['コーヒー', '', 'ランチ'], usdc: ['', '', ''] },
  thanks: 'Thanks! 🎉',
  thanksUrl: 'https://t.example.com/x?a=1&b=2',
};

function seed(settings: Record<string, unknown>) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}

// この画面の <svg> は lucide-react の icon と QR (qrcode.react)。版更新で path data や既定の描画属性が変わると
// 自前の code と無関係に hash が落ちるので、複製した tree の各 <svg> の子を空にし、属性は配置と a11y に効く
// class/width/height/role/aria-* だけ残し、class からも lucide / lucide-* を外す (R10a・R11b・PR-19 の網と同じ規則)。
// QR の中身は modal の本文に出る URL の文字で固定される。受信箱の <time> の文字は実行環境の時間帯で変わるので
// 空にする (dateTime 属性は UTC のまま残し、文字は別に assertion する)。それ以外の DOM は bytes のまま。
const SVG_KEPT_ATTR = /^(class|width|height|role|aria-.+)$/;
function normalized(root: HTMLElement) {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const svg of copy.querySelectorAll('svg')) {
    svg.replaceChildren();
    for (const { name } of [...svg.attributes]) if (!SVG_KEPT_ATTR.test(name)) svg.removeAttribute(name);
    const cls = svg.getAttribute('class');
    if (cls !== null) {
      svg.setAttribute('class', cls.split(/\s+/).filter((c) => c && c !== 'lucide' && !c.startsWith('lucide-')).join(' '));
    }
  }
  for (const time of copy.querySelectorAll('time')) time.replaceChildren();
  return copy;
}
// all = 全 DOM の sha256 (網の本体)。parts = grid の 3 列 (受け取り・表示・プレビューと公開) と受信箱ごとの短い hash と
// 冒頭の文字で、落ちたときにどの節が変わったかを snapshot の diff に出す補助 (all は弱めない)。行単位の差分が要るときは、
// 一時的に normalized(container).innerHTML を分割前後の両 tree で書き出して diff する。
// 基準値を意図して採り直すのは DOM を意図して変えたときだけ (分割では採り直さない)。
function hashDom(container: HTMLElement) {
  const sha256 = (html: string) => createHash('sha256').update(html).digest('hex');
  const dom = normalized(container);
  const [grid, ...rest] = [...dom.firstElementChild!.children];
  return {
    all: sha256(dom.innerHTML),
    parts: [...grid.children, ...rest].map((el) => (
      `${el.tagName.toLowerCase()} ${sha256(el.outerHTML).slice(0, 12)} ${el.textContent!.slice(0, 16)}`
    )),
  };
}

const writeText = vi.fn(async (_value: string) => {});
function tipUrlText() {
  return screen.getByRole('heading', { name: 'Tip URL' }).nextElementSibling!.textContent;
}
function snippetText(container: HTMLElement) {
  return container.querySelector('pre code')!.textContent;
}
function previewParams() {
  return JSON.parse(screen.getByTestId('tip-preview-params').textContent!);
}
async function ready() {
  await screen.findByTestId('tip-preview-params');
}
async function readyWithUrl() {
  await ready();
  await waitFor(() => expect(tipUrlText()).toMatch(/^https:\/\/test\.local\/tip\//));
}

// 公開のカードが出す生成物を全部読む (share → embed iframe → embed ボタン → share に戻す)。
// クリップボードに書いた値・「新しいタブ」の href・QR の本文も同じ URL / snippet であることを確かめる。
async function generatedOutputs(container: HTMLElement) {
  const url = tipUrlText()!;
  const x = screen.getByRole('link', { name: 'X シェア' }).getAttribute('href');
  expect(screen.getByRole('link', { name: '新しいタブ' })).toHaveAttribute('href', url);
  fireEvent.click(screen.getByRole('button', { name: 'サイトに埋め込む' }));
  const iframe = snippetText(container)!;
  fireEvent.click(screen.getByRole('button', { name: 'ボタン' }));
  const button = snippetText(container)!;
  fireEvent.click(screen.getByRole('button', { name: 'iframe' }));
  fireEvent.click(screen.getByRole('button', { name: 'リンクで共有' }));
  return { url, x, iframe, button };
}

beforeEach(() => {
  h.enableTipMessage = false;
  h.connected = undefined;
  h.resolve = {};
  h.signedIn = false;
  h.previewMounts = 0;
  localStorage.clear();
  writeText.mockClear();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('TipEmbedGenerator pre-split pinning (F-8 PR-20)', () => {
  it('pins the DOM of a fresh generator (ja): share / embed iframe / embed button placeholders', async () => {
    const view = renderWithIntl(<TipEmbedGenerator />);
    await ready();
    expect(screen.getByTestId('tip-copy-primary')).toBeDisabled();
    expect(previewParams()).toMatchInlineSnapshot(`
      {
        "chain": "polygon",
        "color": "#2563eb",
        "mode": "gasless",
        "presets": [
          "300",
          "1000",
          "3000",
        ],
        "theme": "clean",
        "to": "0x0000000000000000000000000000000000000001",
        "token": "jpyc",
      }
    `);
    const share = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'サイトに埋め込む' }));
    expect(screen.getByRole('button', { name: 'コピー' })).toBeDisabled();
    const embedIframe = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'ボタン' }));
    const embedButton = hashDom(view.container);
    expect({ share, embedIframe, embedButton }).toMatchInlineSnapshot(`
      {
        "embedButton": {
          "all": "2a47117f11aee355c6fe3e56d2197432e75c1730df122531b08bd3ba4399bd7e",
          "parts": [
            "div d5ada4b1d3e5 受け取り受取ウォレットアドレス通",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div 83a04c78e880 プレビュー{"to":"0x00",
          ],
        },
        "embedIframe": {
          "all": "17373ec79829e1d590c26019a34edb6087046edcbd313dec350bfae5439a5a42",
          "parts": [
            "div d5ada4b1d3e5 受け取り受取ウォレットアドレス通",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div 257c7e916138 プレビュー{"to":"0x00",
          ],
        },
        "share": {
          "all": "afcf61b89efb5f846c997410f7a157e38b38ec9fe5f0cf451db14d762eca949b",
          "parts": [
            "div d5ada4b1d3e5 受け取り受取ウォレットアドレス通",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div ca8bfe5c21df プレビュー{"to":"0x00",
          ],
        },
      }
    `);
  });

  it('pins every generated output and the publish states for a rich JPYC (Kaia) setup', async () => {
    seed(RICH);
    const view = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    expect(await generatedOutputs(view.container)).toMatchInlineSnapshot(`
      {
        "button": "<a href="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&amp;chain=kaia&amp;name=A%26B+%22Tip%22+%3CShop%3E&amp;message=%E5%BF%9C%E6%8F%B4%E3%81%82%E3%82%8A%E3%81%8C%E3%81%A8%E3%81%862+%E8%A1%8C%E7%9B%AE&amp;color=%23ff0080&amp;theme=night&amp;preset=500%7C%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%2C1500%2C5000%7C%E3%83%A9%E3%83%B3%E3%83%81&amp;thanks=Thanks%21+%F0%9F%8E%89&amp;thanksUrl=https%3A%2F%2Ft.example.com%2Fx%3Fa%3D1%26b%3D2" target="_blank" rel="noopener"
        style="display:inline-block;background:#ff0080;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">A&amp;B &quot;Tip&quot; &lt;Shop&gt; さんにチップ</a>",
        "iframe": "<iframe
        src="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&amp;chain=kaia&amp;name=A%26B+%22Tip%22+%3CShop%3E&amp;message=%E5%BF%9C%E6%8F%B4%E3%81%82%E3%82%8A%E3%81%8C%E3%81%A8%E3%81%862+%E8%A1%8C%E7%9B%AE&amp;color=%23ff0080&amp;theme=night&amp;preset=500%7C%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%2C1500%2C5000%7C%E3%83%A9%E3%83%B3%E3%83%81&amp;thanks=Thanks%21+%F0%9F%8E%89&amp;thanksUrl=https%3A%2F%2Ft.example.com%2Fx%3Fa%3D1%26b%3D2"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
        "url": "https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&chain=kaia&name=A%26B+%22Tip%22+%3CShop%3E&message=%E5%BF%9C%E6%8F%B4%E3%81%82%E3%82%8A%E3%81%8C%E3%81%A8%E3%81%862+%E8%A1%8C%E7%9B%AE&color=%23ff0080&theme=night&preset=500%7C%E3%82%B3%E3%83%BC%E3%83%92%E3%83%BC%2C1500%2C5000%7C%E3%83%A9%E3%83%B3%E3%83%81&thanks=Thanks%21+%F0%9F%8E%89&thanksUrl=https%3A%2F%2Ft.example.com%2Fx%3Fa%3D1%26b%3D2",
        "x": "https://twitter.com/intent/tweet?text=A%26B%20%22Tip%22%20%3CShop%3E%20%E3%81%95%E3%82%93%E3%81%B8%20%E2%80%94%20OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913%3Ftoken%3Djpyc%26chain%3Dkaia%26name%3DA%2526B%2B%2522Tip%2522%2B%253CShop%253E%26message%3D%25E5%25BF%259C%25E6%258F%25B4%25E3%2581%2582%25E3%2582%258A%25E3%2581%258C%25E3%2581%25A8%25E3%2581%25862%2B%25E8%25A1%258C%25E7%259B%25AE%26color%3D%2523ff0080%26theme%3Dnight%26preset%3D500%257C%25E3%2582%25B3%25E3%2583%25BC%25E3%2583%2592%25E3%2583%25BC%252C1500%252C5000%257C%25E3%2583%25A9%25E3%2583%25B3%25E3%2583%2581%26thanks%3DThanks%2521%2B%25F0%259F%258E%2589%26thanksUrl%3Dhttps%253A%252F%252Ft.example.com%252Fx%253Fa%253D1%2526b%253D2",
      }
    `);
    expect(previewParams()).toMatchInlineSnapshot(`
      {
        "chain": "kaia",
        "color": "#ff0080",
        "message": "応援ありがとう
      2 行目",
        "mode": "gasless",
        "name": "A&B "Tip" <Shop>",
        "presets": [
          "500|コーヒー",
          "1500",
          "5000|ランチ",
        ],
        "theme": "night",
        "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "token": "jpyc",
      }
    `);
    expect(screen.getByTestId('tip-preview-params')).toHaveAttribute('data-preview', 'true');
    const url = tipUrlText()!;
    const share = hashDom(view.container);

    fireEvent.click(screen.getByTestId('tip-copy-primary'));
    await screen.findByRole('button', { name: 'コピー済み' });
    const copied = hashDom(view.container);

    fireEvent.click(screen.getByRole('button', { name: /^QR$/ }));
    const dialog = screen.getByRole('dialog', { name: 'リンクの QR コード' });
    expect(dialog.querySelector('p.text-xs')).toHaveTextContent(url, { normalizeWhitespace: false });
    const qr = hashDom(view.container);
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));

    fireEvent.click(screen.getByRole('button', { name: 'サイトに埋め込む' }));
    const iframe = snippetText(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'コピー' }));
    await screen.findByRole('button', { name: 'コピー済み' });
    const embedIframe = hashDom(view.container);

    fireEvent.click(screen.getByRole('button', { name: 'ボタン' }));
    const button = snippetText(view.container);
    const embedButton = hashDom(view.container);
    // iframe とボタンのコピーは同じ useCopyToClipboard を共有する (コピー済みの表示は 1.5 秒後に戻る)。
    await screen.findByRole('button', { name: 'コピー' }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'コピー' }));
    await screen.findByRole('button', { name: 'コピー済み' });

    expect(writeText.mock.calls.map(([value]) => value)).toEqual([url, iframe, button]);
    expect({ share, copied, qr, embedIframe, embedButton }).toMatchInlineSnapshot(`
      {
        "copied": {
          "all": "954f7256216988329bb5a8879337a5732ed6bc8928bc0d2c1e74553868891808",
          "parts": [
            "div cc9b30f810d7 受け取り設定0x8335…291",
            "div d87df287843b 表示をカスタマイズ表示名 (任意",
            "div dd53dfec8b10 プレビュー{"to":"0x83",
          ],
        },
        "embedButton": {
          "all": "71f43783186aeef6d8bf7c9feb26e2947c5b6f6d1d99600510d806e433b54465",
          "parts": [
            "div cc9b30f810d7 受け取り設定0x8335…291",
            "div d87df287843b 表示をカスタマイズ表示名 (任意",
            "div d8bec88f33cb プレビュー{"to":"0x83",
          ],
        },
        "embedIframe": {
          "all": "d79244ac0d051e7464ae9eefd69d6b30fe6befce4c6e22c75a27084827ebeebb",
          "parts": [
            "div cc9b30f810d7 受け取り設定0x8335…291",
            "div d87df287843b 表示をカスタマイズ表示名 (任意",
            "div 844777db49d3 プレビュー{"to":"0x83",
          ],
        },
        "qr": {
          "all": "5cfbae6f03955abeaed5755f8aae3ab1a41d6d1a8cc61fcb2e480f5e3835b2a0",
          "parts": [
            "div cc9b30f810d7 受け取り設定0x8335…291",
            "div d87df287843b 表示をカスタマイズ表示名 (任意",
            "div 4e75cc536839 プレビュー{"to":"0x83",
          ],
        },
        "share": {
          "all": "bb3508c861185ae51875321b9c338c43fb99f48843016696f26001171d689581",
          "parts": [
            "div cc9b30f810d7 受け取り設定0x8335…291",
            "div d87df287843b 表示をカスタマイズ表示名 (任意",
            "div bd1cff7dfef5 プレビュー{"to":"0x83",
          ],
        },
      }
    `);
  });

  it('pins the generated outputs for USDC (Base・他チェーン受取 OFF / Arbitrum・端数の金額)、ENS 名、不正な色、既定の JPYC', async () => {
    const outputs: Record<string, unknown> = {};

    seed({ receiver: VALID, token: 'usdc', chain: 'base', crossChain: false, name: 'Bob' });
    let view = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    outputs.usdcBaseNoCrossChain = { ...(await generatedOutputs(view.container)), preview: previewParams() };
    view.unmount();

    seed({
      receiver: VALID,
      token: 'usdc',
      chain: 'arbitrum',
      presets: { jpyc: ['300', '1000', '3000'], usdc: ['1.5', '20.1234567', '50'] },
      presetLabels: { jpyc: ['', '', ''], usdc: ['☕', 'x|y', ''] },
    });
    view = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    outputs.usdcArbitrumPresets = { ...(await generatedOutputs(view.container)), preview: previewParams() };
    view.unmount();

    h.resolve = { 'alice.eth': OTHER };
    seed({ receiver: 'alice.eth', message: 'hi' });
    view = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    outputs.ensName = await generatedOutputs(view.container);
    view.unmount();

    seed({ receiver: VALID, name: 'Carol' });
    view = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    fireEvent.change(screen.getByPlaceholderText('#2563eb'), { target: { value: 'red' } });
    await waitFor(() => expect(tipUrlText()).not.toContain('color='));
    outputs.invalidColor = { ...(await generatedOutputs(view.container)), preview: previewParams() };
    view.unmount();

    localStorage.clear();
    view = renderWithIntl(<TipEmbedGenerator />);
    await ready();
    fireEvent.change(screen.getByPlaceholderText(/0x\.\.\./), { target: { value: VALID } });
    await readyWithUrl();
    outputs.defaultJpyc = await generatedOutputs(view.container);

    expect(outputs).toMatchInlineSnapshot(`
      {
        "defaultJpyc": {
          "button": "<a href="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&amp;color=%232563eb" target="_blank" rel="noopener"
        style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">チップを送る</a>",
          "iframe": "<iframe
        src="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&amp;color=%232563eb"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
          "url": "https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&color=%232563eb",
          "x": "https://twitter.com/intent/tweet?text=OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913%3Ftoken%3Djpyc%26color%3D%25232563eb",
        },
        "ensName": {
          "button": "<a href="https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=jpyc&amp;message=hi&amp;color=%232563eb" target="_blank" rel="noopener"
        style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">チップを送る</a>",
          "iframe": "<iframe
        src="https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=jpyc&amp;message=hi&amp;color=%232563eb"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
          "url": "https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=jpyc&message=hi&color=%232563eb",
          "x": "https://twitter.com/intent/tweet?text=OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x000000000000000000000000000000000000dEaD%3Ftoken%3Djpyc%26message%3Dhi%26color%3D%25232563eb",
        },
        "invalidColor": {
          "button": "<a href="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&amp;name=Carol" target="_blank" rel="noopener"
        style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">Carol さんにチップ</a>",
          "iframe": "<iframe
        src="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&amp;name=Carol"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
          "preview": {
            "chain": "polygon",
            "mode": "gasless",
            "name": "Carol",
            "presets": [
              "300",
              "1000",
              "3000",
            ],
            "theme": "clean",
            "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "token": "jpyc",
          },
          "url": "https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&name=Carol",
          "x": "https://twitter.com/intent/tweet?text=Carol%20%E3%81%95%E3%82%93%E3%81%B8%20%E2%80%94%20OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913%3Ftoken%3Djpyc%26name%3DCarol",
        },
        "usdcArbitrumPresets": {
          "button": "<a href="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=usdc&amp;chain=arbitrum&amp;color=%232563eb&amp;preset=1.5%7C%E2%98%95%2C20.123456%7Cxy%2C50" target="_blank" rel="noopener"
        style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">チップを送る</a>",
          "iframe": "<iframe
        src="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=usdc&amp;chain=arbitrum&amp;color=%232563eb&amp;preset=1.5%7C%E2%98%95%2C20.123456%7Cxy%2C50"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
          "preview": {
            "chain": "arbitrum",
            "color": "#2563eb",
            "crossChain": true,
            "mode": "gasless",
            "presets": [
              "1.5|☕",
              "20.123456|xy",
              "50",
            ],
            "theme": "clean",
            "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "token": "usdc",
          },
          "url": "https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=usdc&chain=arbitrum&color=%232563eb&preset=1.5%7C%E2%98%95%2C20.123456%7Cxy%2C50",
          "x": "https://twitter.com/intent/tweet?text=OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913%3Ftoken%3Dusdc%26chain%3Darbitrum%26color%3D%25232563eb%26preset%3D1.5%257C%25E2%2598%2595%252C20.123456%257Cxy%252C50",
        },
        "usdcBaseNoCrossChain": {
          "button": "<a href="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=usdc&amp;name=Bob&amp;color=%232563eb&amp;crossChain=false" target="_blank" rel="noopener"
        style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">Bob さんにチップ</a>",
          "iframe": "<iframe
        src="https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=usdc&amp;name=Bob&amp;color=%232563eb&amp;crossChain=false"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
          "preview": {
            "chain": "base",
            "color": "#2563eb",
            "crossChain": false,
            "mode": "gasless",
            "name": "Bob",
            "presets": [
              "5",
              "20",
              "50",
            ],
            "theme": "clean",
            "to": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "token": "usdc",
          },
          "url": "https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=usdc&name=Bob&color=%232563eb&crossChain=false",
          "x": "https://twitter.com/intent/tweet?text=Bob%20%E3%81%95%E3%82%93%E3%81%B8%20%E2%80%94%20OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913%3Ftoken%3Dusdc%26name%3DBob%26color%3D%25232563eb%26crossChain%3Dfalse",
        },
      }
    `);
  });

  it('pins the receive card: invalid address・USDC inline with the cross-chain toggle・settings sheet・en + connected wallet', async () => {
    const view = renderWithIntl(<TipEmbedGenerator />);
    await ready();
    fireEvent.change(screen.getByPlaceholderText(/0x\.\.\./), { target: { value: '0x123' } });
    await screen.findByText('アドレス形式が正しくありません');
    const invalidAddress = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: /USDC/ }));
    expect(screen.getByRole('checkbox', { name: /他チェーンからの tip を許可/ })).toBeChecked();
    const usdcInline = hashDom(view.container);
    view.unmount();

    seed({ receiver: VALID, token: 'usdc', chain: 'base', crossChain: false });
    const saved = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    const summary = hashDom(saved.container);
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    const sheet = screen.getByRole('dialog', { name: '受け取りの設定' });
    expect(within(sheet).getByRole('checkbox', { name: /他チェーンからの tip を許可/ })).not.toBeChecked();
    const settingsSheet = hashDom(saved.container);
    saved.unmount();

    h.connected = VALID;
    const connected = renderWithIntl(<TipEmbedGenerator />, { locale: 'en' });
    await screen.findByTestId('tip-preview-params');
    await screen.findByText('0x8335…2913');
    expect({ invalidAddress, usdcInline, summary, settingsSheet, en: hashDom(connected.container) }).toMatchInlineSnapshot(`
      {
        "en": {
          "all": "4a847683cde6112557482a55b2dd535a94834e33684d3bcffe6b4064c5b502a7",
          "parts": [
            "div 3d2fd5e3918b ReceivingSetting",
            "div a5e75769c87d Customize appear",
            "div d223e6b0ea94 Preview{"to":"0x",
          ],
        },
        "invalidAddress": {
          "all": "23a62ba73dae9203dd5b2589abe35f4d2d43115d7c37632f723184dbf09774f9",
          "parts": [
            "div d9c47fd3db3d 受け取り受取ウォレットアドレスア",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div ca8bfe5c21df プレビュー{"to":"0x00",
          ],
        },
        "settingsSheet": {
          "all": "bb2e95668adcd04e5d1ee7949445bcfb45248da9ccc468342eb5d5fae8754dbf",
          "parts": [
            "div 185c0a33cf7d 受け取り設定0x8335…291",
            "div 61cdf0c0ed6f 表示をカスタマイズ表示名 (任意",
            "div 556814a4cd21 プレビュー{"to":"0x83",
          ],
        },
        "summary": {
          "all": "f5455cd1a2b6a2b4584cc765933c90e81f67008c026e8bcf02a583d8b04b57bf",
          "parts": [
            "div 2aa00a3cbd49 受け取り設定0x8335…291",
            "div 61cdf0c0ed6f 表示をカスタマイズ表示名 (任意",
            "div 556814a4cd21 プレビュー{"to":"0x83",
          ],
        },
        "usdcInline": {
          "all": "97f12fd22d359f8ceff8a02294bde75e8637003afb1184964f1efd6dd5b538fb",
          "parts": [
            "div 1c02443aa843 受け取り受取ウォレットアドレスア",
            "div 61cdf0c0ed6f 表示をカスタマイズ表示名 (任意",
            "div d7a53bc7786e プレビュー{"to":"0x00",
          ],
        },
      }
    `);
  });

  it('pins the customize card (dev settings open・invalid color・six presets with labels) and the long-URL share (QR omitted)', async () => {
    const view = renderWithIntl(<TipEmbedGenerator />);
    await ready();
    fireEvent.change(screen.getByPlaceholderText('例: 山田太郎'), { target: { value: 'Dana' } });
    fireEvent.change(screen.getByPlaceholderText('#2563eb'), { target: { value: '#12' } });
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole('button', { name: /金額を追加/ }));
    expect(screen.queryByRole('button', { name: /金額を追加/ })).toBeNull();
    const amounts = screen.getAllByPlaceholderText('例: 1000');
    fireEvent.change(amounts[3], { target: { value: '12.5' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'ラベル 1' }), { target: { value: 'お茶' } });
    fireEvent.click(screen.getByText(/開発者向け設定/, { selector: 'summary span' }));
    fireEvent.change(screen.getByPlaceholderText(/限定 Discord に招待します/), { target: { value: 'ありがとう' } });
    fireEvent.change(screen.getByPlaceholderText(/discord\.gg/), { target: { value: 'https://discord.gg/x' } });
    const customize = hashDom(view.container);
    view.unmount();

    seed({ receiver: VALID, thanksUrl: `https://links.example.com/${'a'.repeat(1400)}` });
    const long = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    expect(screen.queryByRole('button', { name: /^QR$/ })).toBeNull();
    expect({ customize, longUrl: hashDom(long.container) }).toMatchInlineSnapshot(`
      {
        "customize": {
          "all": "2a8b785ba28f2b8d4cf18056f61ffb992840a7d5bd540dcc9b34df2872ae02b7",
          "parts": [
            "div d5ada4b1d3e5 受け取り受取ウォレットアドレス通",
            "div a62856787fe2 表示をカスタマイズ表示名 (任意",
            "div 50576f4ed7ab プレビュー{"to":"0x00",
          ],
        },
        "longUrl": {
          "all": "2f701507cd23ec1772161206df5c027783a407d54c7fb637251cb194719fadcd",
          "parts": [
            "div d8a83614887d 受け取り設定0x8335…291",
            "div b852a2c6224e 表示をカスタマイズ表示名 (任意",
            "div de177d5b3582 プレビュー{"to":"0x83",
          ],
        },
      }
    `);
  });

  it('pins the tip message inbox (signed out / items / load error / empty / delete error)', async () => {
    h.enableTipMessage = true;
    h.connected = VALID;
    const item = (n: number, message: string) => ({
      from: `0x${String(n).repeat(40)}`,
      amountWei: (BigInt(n) * 10n ** 18n + 5n * 10n ** 17n).toString(),
      chainId: 80002,
      txHash: `0x${String(n).repeat(64)}`,
      message,
      ts: Date.UTC(2026, 6, 28, 3, n, 0),
    });
    const items = [item(1, '1 行目\n<b>2 行目</b>'), item(2, 'thanks')];
    const renderInbox = () => {
      const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      return renderWithIntl(
        <QueryClientProvider client={client}>
          <TipEmbedGenerator />
        </QueryClientProvider>,
      );
    };
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    let view = renderInbox();
    await screen.findByTestId('tip-message-inbox');
    await ready();
    const signedOut = hashDom(view.container);
    view.unmount();
    expect(fetchSpy).not.toHaveBeenCalled();

    h.signedIn = true;
    fetchSpy.mockImplementation(async (_url, init) => (
      init?.method === 'DELETE' ? json({ error: 'x' }, 500) : json({ items })
    ));
    view = renderInbox();
    const inbox = await screen.findByTestId('tip-message-inbox');
    await within(inbox).findByText('thanks');
    await ready();
    const format = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' });
    expect([...inbox.querySelectorAll('time')].map((el) => [el.getAttribute('datetime'), el.textContent])).toEqual(
      items.map((it) => [new Date(it.ts).toISOString(), format.format(new Date(it.ts))]),
    );
    const withItems = hashDom(view.container);
    fireEvent.click(within(inbox).getByRole('button', { name: 'すべて削除' }));
    await within(inbox).findByText('削除できませんでした。もう一度お試しください。');
    const deleteError = hashDom(view.container);
    view.unmount();

    fetchSpy.mockImplementation(async () => json({ error: 'unavailable' }, 503));
    view = renderInbox();
    await within(await screen.findByTestId('tip-message-inbox')).findByRole('button', { name: /再読み込み/ });
    await ready();
    const loadError = hashDom(view.container);
    view.unmount();

    fetchSpy.mockImplementation(async () => json({ items: [] }));
    view = renderInbox();
    const empty = await screen.findByTestId('tip-message-inbox');
    await waitFor(() => expect(empty.querySelector('p.bg-slate-50')).not.toBeNull());
    await ready();
    expect({ signedOut, withItems, deleteError, loadError, empty: hashDom(view.container) }).toMatchInlineSnapshot(`
      {
        "deleteError": {
          "all": "533f3a64df2c476eef9d57afc582f0a5465a74f322c69370130600e2ffbb99f2",
          "parts": [
            "div 9412765c9170 受け取り設定0x8335…291",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div fdc1091bbc54 プレビュー{"to":"0x83",
            "section 13f0ce7108d7 受け取った応援メッセージ非公開で",
          ],
        },
        "empty": {
          "all": "4099b391dfc352e5a1b34f5e0e6d4787e558028560812253413c95934675c5e3",
          "parts": [
            "div 9412765c9170 受け取り設定0x8335…291",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div fdc1091bbc54 プレビュー{"to":"0x83",
            "section 04ce4b993671 受け取った応援メッセージ非公開で",
          ],
        },
        "loadError": {
          "all": "29d4a1d5ee04d427a6f727364b1e0749b6141790ffefa8e26cc1fe33f8129780",
          "parts": [
            "div 9412765c9170 受け取り設定0x8335…291",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div fdc1091bbc54 プレビュー{"to":"0x83",
            "section 934c373aa49d 受け取った応援メッセージ非公開で",
          ],
        },
        "signedOut": {
          "all": "4f4c0f767c7eb51a0a2f9c4f01b60dbbdd67a567c01367550c19e84d19bc8bf4",
          "parts": [
            "div 9412765c9170 受け取り設定0x8335…291",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div fdc1091bbc54 プレビュー{"to":"0x83",
            "section 19dbeffd530a 受け取った応援メッセージ非公開で",
          ],
        },
        "withItems": {
          "all": "3b9cf9f07b393c836fe879c2da3452e57b686426c85448d3304ce188e0f6b0af",
          "parts": [
            "div 9412765c9170 受け取り設定0x8335…291",
            "div d49064b8587d 表示をカスタマイズ表示名 (任意",
            "div fdc1091bbc54 プレビュー{"to":"0x83",
            "section 376ac60a4f68 受け取った応援メッセージ非公開で",
          ],
        },
      }
    `);
  });

  it('子 component に分けても入力欄・折りたたみを作り直さず、プレビューは通貨・チェーン・金額が変わったときだけ作り直す', async () => {
    seed(RICH);
    const view = renderWithIntl(<TipEmbedGenerator />);
    await readyWithUrl();
    fireEvent.click(screen.getByText(/開発者向け設定/, { selector: 'summary span' }));
    const details = [...view.container.querySelectorAll('details')];
    expect(details.every((d) => d.open)).toBe(true);
    const mounts: Array<[string, number]> = [['initial', h.previewMounts]];
    const fields = () => ({
      name: screen.getByPlaceholderText('例: 山田太郎'),
      message: screen.getByPlaceholderText('例: 応援ありがとうございます！'),
      colorText: screen.getByPlaceholderText('#2563eb'),
      presetAmount: screen.getAllByPlaceholderText('例: 1000')[1],
      presetLabel: screen.getByRole('textbox', { name: 'ラベル 2' }),
      thanks: screen.getByPlaceholderText(/限定 Discord に招待します/),
      thanksUrl: screen.getByPlaceholderText(/discord\.gg/),
    });
    const before = fields();
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      const node = before[key] as HTMLInputElement;
      node.focus();
      fireEvent.change(node, { target: { value: key === 'colorText' ? '#00ff00' : key === 'presetAmount' ? '1600' : `${node.value}x` } });
      expect(fields()[key]).toBe(node);
      expect(node).toHaveFocus();
      await screen.findByTestId('tip-preview-params');
      mounts.push([key, h.previewMounts]);
    }
    expect([...view.container.querySelectorAll('details')]).toEqual(details);
    expect(details.every((d) => d.open)).toBe(true);

    // 受け取りの設定シートの入力欄も、打っている間に作り直さない。
    fireEvent.click(screen.getByRole('button', { name: '設定' }));
    const sheetInput = within(screen.getByRole('dialog')).getByPlaceholderText(/0x\.\.\./);
    sheetInput.focus();
    fireEvent.change(sheetInput, { target: { value: OTHER } });
    expect(within(screen.getByRole('dialog')).getByPlaceholderText(/0x\.\.\./)).toBe(sheetInput);
    expect(sheetInput).toHaveFocus();
    await waitFor(() => expect(tipUrlText()).toContain(`/tip/${OTHER}`));
    // チェーンを変えるとプレビューを作り直す (key に入っている)。
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: new RegExp(`id:\\s*${chainForSlug('polygon').id}\\b`) }));
    await screen.findByTestId('tip-preview-params');
    await waitFor(() => expect(previewParams().chain).toBe('polygon'));
    mounts.push(['chain', h.previewMounts]);
    expect(mounts).toMatchInlineSnapshot(`
      [
        [
          "initial",
          2,
        ],
        [
          "name",
          2,
        ],
        [
          "message",
          2,
        ],
        [
          "colorText",
          2,
        ],
        [
          "presetAmount",
          3,
        ],
        [
          "presetLabel",
          4,
        ],
        [
          "thanks",
          4,
        ],
        [
          "thanksUrl",
          4,
        ],
        [
          "chain",
          5,
        ],
      ]
    `);
  });

  // 公開のカードを出したまま受取先・金額・通貨を変えたら、コピー・QR・新しいタブ・X シェアは変えた後の URL /
  // コードを使う (mount 時や前の受取先の値を握った callback・ref を検出する)。共有のパネルは URL が出た時点で、
  // 埋め込みのパネルは切り替えた時点で mount されるので、それぞれ mount の後に変えてから操作する。
  it('表示中に受取先・金額・通貨を変えた後のコピーと QR は、変えた後の URL / コードを使う', async () => {
    const view = renderWithIntl(<TipEmbedGenerator />);
    await ready();
    fireEvent.change(screen.getByPlaceholderText(/0x\.\.\./), { target: { value: VALID } });
    await readyWithUrl();
    const before = tipUrlText()!;
    expect(before).toContain(`/tip/${VALID}`);
    expect(screen.getByRole('button', { name: /^QR$/ })).toBeInTheDocument();

    // 共有のパネル (と QR の modal) が mount された後に、受取先と金額を変える。
    fireEvent.change(screen.getByPlaceholderText(/0x\.\.\./), { target: { value: OTHER } });
    fireEvent.change(screen.getAllByPlaceholderText('例: 1000')[0], { target: { value: '700' } });
    await waitFor(() => expect(tipUrlText()).toContain('preset=700'));
    const shared = tipUrlText()!;
    expect(shared).toContain(`/tip/${OTHER}`);
    expect(screen.getByRole('link', { name: '新しいタブ' })).toHaveAttribute('href', shared);
    const x = screen.getByRole('link', { name: 'X シェア' }).getAttribute('href');
    fireEvent.click(screen.getByTestId('tip-copy-primary'));
    await screen.findByRole('button', { name: 'コピー済み' });
    fireEvent.click(screen.getByRole('button', { name: /^QR$/ }));
    const dialog = screen.getByRole('dialog', { name: 'リンクの QR コード' });
    const qr = dialog.querySelector('p.text-xs')!.textContent;
    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));

    // 埋め込みのパネルが mount された後に、通貨を変える (受取先は OTHER のまま)。
    fireEvent.click(screen.getByRole('button', { name: 'サイトに埋め込む' }));
    expect(snippetText(view.container)).toContain('preset=700');
    fireEvent.click(screen.getByRole('button', { name: /USDC/ }));
    await waitFor(() => expect(snippetText(view.container)).toContain('token=usdc'));
    const iframe = snippetText(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'コピー' }));
    await screen.findByRole('button', { name: 'コピー済み' });
    fireEvent.click(screen.getByRole('button', { name: 'ボタン' }));
    const button = snippetText(view.container);
    fireEvent.click(screen.getByRole('button', { name: /^コピー(済み)?$/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(3));

    const clipboard = writeText.mock.calls.map(([value]) => value);
    // コピーと QR は、その時に画面に出ている URL / コードと同じで、前の受取先・金額・通貨の値ではない。
    expect(clipboard).toEqual([shared, iframe, button]);
    expect(qr).toBe(shared);
    for (const value of [...clipboard, qr!, x!]) expect(value).not.toContain(VALID);
    expect({ before, clipboard, qr, x }).toMatchInlineSnapshot(`
      {
        "before": "https://test.local/tip/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913?token=jpyc&color=%232563eb",
        "clipboard": [
          "https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=jpyc&color=%232563eb&preset=700%2C1000%2C3000",
          "<iframe
        src="https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=usdc&amp;color=%232563eb"
        width="380"
        height="640"
        style="border:0;max-width:100%"
        title="OpenPay Tip"
        loading="lazy"
      ></iframe>",
          "<a href="https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=usdc&amp;color=%232563eb" target="_blank" rel="noopener"
        style="display:inline-block;background:#2563eb;color:#fff;font-weight:700;padding:12px 22px;border-radius:9999px;text-decoration:none;font-family:system-ui,-apple-system,sans-serif">チップを送る</a>",
        ],
        "qr": "https://test.local/tip/0x000000000000000000000000000000000000dEaD?token=jpyc&color=%232563eb&preset=700%2C1000%2C3000",
        "x": "https://twitter.com/intent/tweet?text=OpenPay%20%E3%81%A7%20JPYC%20%2F%20USDC%20%E3%81%AE%E3%83%81%E3%83%83%E3%83%97%E3%82%92%E9%80%81%E3%82%8C%E3%81%BE%E3%81%99&url=https%3A%2F%2Ftest.local%2Ftip%2F0x000000000000000000000000000000000000dEaD%3Ftoken%3Djpyc%26color%3D%25232563eb%26preset%3D700%252C1000%252C3000",
      }
    `);
  });
});
