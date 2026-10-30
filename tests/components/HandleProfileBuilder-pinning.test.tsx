import { createHash } from 'node:crypto';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';

// F-8 PR-19 (HandleProfileBuilder をセクション単位の component に分ける) の網。期待値はすべて分割前の
// component (origin/main b90757b9) で採取したもの。分割に合わせて採り直さない — hash が変わったら DOM が
// 変わったので、分割の方を直す。固定するもの:
//   - 全 DOM の hash (新規・接続済み・入力済みで任意のまとまりを全部開いた状態・受け取りのシート 2 通り・
//     編集中 → 未公開の変更 → コピー済み → QR → 公開 → 編集をやめる)
//   - 公開に送る payload の完全一致 (入力済みの下書き)
//   - claim panel に渡す props (payload・止める理由・編集中の handle・dirty・自動編集の可否・公開ボタンの帯の置き場)
//   - 子 component に分けても入力欄・折りたたみ・画像の失敗状態を作り直さないこと (node の同一性と focus)
// 振る舞いの細部 (検証・自動補完・並べ替え・embed の上限 等) は HandleProfileBuilder.test.tsx が固定している。

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0x000000000000000000000000000000000000dEaD';
const STORAGE_KEY = 'openpay:handle-profile-draft:v1';
const h = vi.hoisted(() => ({
  arc: false,
  enableJpycAvalanche: false,
  connectedAddress: undefined as string | undefined,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    isArcTipEnabled: () => h.arc,
    env: {
      ...actual.env,
      enableHandles: true,
      get enableJpycAvalanche() {
        return h.enableJpycAvalanche;
      },
    },
  };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.connectedAddress }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useResolveAddress', () => ({
  useResolveAddress: (input: string) => ({ data: input === 'alice.eth' ? { address: ADDR } : null }),
}));
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="addr" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));
// 本物の claim panel (SIWE/react-query) は持ち込まず、受け取った props をすべて DOM に書き出す
// (→ DOM の hash に入る)。公開ボタンの帯は本物と同じく barSlots へ portal する (置き場の配線を固定する)。
vi.mock('@/components/HandleClaimPanel', () => ({
  HandleClaimPanel: (props: {
    payload: unknown;
    publishBlockedReason?: string;
    onEdit: (handle: string, config: unknown, profile?: unknown, updatedAt?: number) => void;
    editingHandle: string | null;
    expectedUpdatedAt?: number;
    isDirty: boolean;
    onStopEditing: () => void;
    canAutoEdit?: unknown;
    barSlots: [HTMLElement | null, HTMLElement | null];
    onPublished: (snapshot: { handle: string; payload: unknown; updatedAt: number }) => void;
  }) => (
    <div
      data-testid="claim"
      data-payload={JSON.stringify(props.payload)}
      data-blocked={props.publishBlockedReason ?? ''}
      data-editing={props.editingHandle ?? ''}
      data-expected-updated-at={props.expectedUpdatedAt ?? ''}
      data-dirty={String(props.isDirty)}
      data-can-auto-edit={props.canAutoEdit ? 'yes' : 'no'}
    >
      <button
        type="button"
        data-testid="edit-named"
        onClick={() => props.onEdit(
          'alice',
          { to: ADDR, name: 'Published Alice', methods: [{ token: 'jpyc', chain: 'polygon' }] },
          { bio: 'Published bio', theme: 'clean' },
          Date.UTC(2026, 6, 10, 10, 0, 0),
        )}
      />
      <button
        type="button"
        data-testid="publish-mock"
        onClick={() => props.payload && props.onPublished({
          handle: 'alice', payload: props.payload, updatedAt: Date.UTC(2026, 6, 10, 11, 0, 0),
        })}
      />
      <button type="button" data-testid="stop-mock" onClick={props.onStopEditing} />
      {props.barSlots[0] && createPortal(<span data-testid="bar-mobile">bar</span>, props.barSlots[0])}
      {props.barSlots[1] && createPortal(<span data-testid="bar-desktop">bar</span>, props.barSlots[1])}
    </div>
  ),
}));

import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';

// 任意のまとまりを全部使った下書き (非 https の SNS・不正な戻り先 URL・注目・見出し・埋め込みを含む)。
const RICH_DRAFT = {
  to: ADDR,
  name: 'Alice',
  bio: 'Hello there',
  avatar: 'https://images.example/avatar.png',
  cover: 'https://images.example/cover.png',
  color: '#ef4444',
  theme: 'gradient',
  font: 'serif',
  linkLayout: 'grid',
  jpycKaia: false,
  usdcBase: true,
  socials: ['https://x.com/alice', 'http://github.com/alice'],
  links: [
    { label: 'Blog', url: 'https://blog.example', emoji: '📝', imageUrl: 'https://images.example/blog.png', featured: true },
    { kind: 'heading', label: 'Music' },
    { label: 'Video', url: 'https://youtu.be/dQw4w9WgXcQ', embed: true },
  ],
  message: 'Hi',
  thanks: 'Thanks!',
  thanksUrl: 'foo',
};

function seed(draft: Record<string, unknown>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

// この画面の <svg> は lucide-react の icon と QR (qrcode.react)。版更新で path data や既定の描画属性が変わると
// 自前の code と無関係に hash が落ちるので、複製した tree の各 <svg> の子を空にし、属性は配置と a11y に効く
// class/width/height/role/aria-* だけ残し、class からも lucide / lucide-* を外す (R10a・R11b の網と同じ規則)。
// QR の中身は modal の本文に出る URL の文字で固定される。<svg> の外の DOM は bytes のまま。
const SVG_KEPT_ATTR = /^(class|width|height|role|aria-.+)$/;
function withoutSvgInternals(root: HTMLElement) {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const svg of copy.querySelectorAll('svg')) {
    svg.replaceChildren();
    for (const { name } of [...svg.attributes]) if (!SVG_KEPT_ATTR.test(name)) svg.removeAttribute(name);
    const cls = svg.getAttribute('class');
    if (cls !== null) {
      svg.setAttribute('class', cls.split(/\s+/).filter((c) => c && c !== 'lucide' && !c.startsWith('lucide-')).join(' '));
    }
  }
  return copy;
}
// all = 全 DOM の sha256 (網の本体)。parts = 左の列の節・右の列・下のバー・modal ごとの短い hash と冒頭の文字で、
// 落ちたときにどの節が変わったかを snapshot の diff に出す補助 (all は弱めない)。行単位の差分が要るときは、
// 一時的に withoutSvgInternals(container).innerHTML を分割前後の両 tree で書き出して diff する。
// 基準値を意図して採り直すのは DOM を意図して変えたときだけ (分割では採り直さない)。
function hashDom(container: HTMLElement) {
  const sha256 = (html: string) => createHash('sha256').update(html).digest('hex');
  const dom = withoutSvgInternals(container);
  const [grid, ...rest] = [...dom.firstElementChild!.children];
  const [left, aside] = [...grid.children];
  return {
    all: sha256(dom.innerHTML),
    parts: [...left.children, aside, ...rest].map((el) => (
      `${el.tagName.toLowerCase()} ${sha256(el.outerHTML).slice(0, 12)} ${el.textContent!.slice(0, 16)}`
    )),
  };
}
function payload() {
  return JSON.parse(screen.getByTestId('claim').getAttribute('data-payload')!);
}
function openAllGroups(container: HTMLElement) {
  for (const summary of container.querySelectorAll('details > summary')) fireEvent.click(summary);
}
function openReceiveSettings() {
  fireEvent.click(screen.getAllByRole('button', { name: /^(設定|Settings)$/ })[0]);
}

beforeEach(() => {
  h.arc = false;
  h.enableJpycAvalanche = false;
  h.connectedAddress = undefined;
  localStorage.clear();
  // 公開ステータスの相対時刻 (「1 時間前」) を固定する。
  vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 10, 12, 0, 0));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('HandleProfileBuilder pre-split pinning (F-8 PR-19)', () => {
  it('pins the DOM of a fresh builder (ja) and a connected wallet (en)', () => {
    const fresh = renderWithIntl(<HandleProfileBuilder />);
    expect(screen.getByTestId('bar-desktop')).toBeInTheDocument();
    const ja = hashDom(fresh.container);
    fresh.unmount();
    h.connectedAddress = ADDR;
    const connected = renderWithIntl(<HandleProfileBuilder />, { locale: 'en' });
    expect(screen.getByTestId('addr')).toHaveValue(ADDR);
    expect({ ja, en: hashDom(connected.container) }).toMatchInlineSnapshot(`
      {
        "en": {
          "all": "53671e72296e91928efb66a13e05f40e45496117398b05b8ac886a33ddf32094",
          "parts": [
            "div 0e1510444f57 Your page",
            "section e5003c3794d2 ReceivingSetting",
            "section 36f50f952efb ProfileDisplay n",
            "aside 75839f06f9ec Preview@Choose a",
            "div c4770e3ba873 bar",
          ],
        },
        "ja": {
          "all": "f4e58a0a26d64030a56b5d084e24199400125783b79ece1de2a1d7bde40ec1b0",
          "parts": [
            "div 346cda5c9257 あなたのページ",
            "section 6de4a6114b18 受け取り設定受取先 (全方法 共",
            "section 3bb42c07083e プロフィール表示名ひとこと (b",
            "aside 85ad6e83cba0 プレビュー@通貨・チェーンを選ぶ",
            "div c4770e3ba873 bar",
          ],
        },
      }
    `);
  });

  it('pins the DOM with every optional group open and the exact publish payload', () => {
    seed(RICH_DRAFT);
    const view = renderWithIntl(<HandleProfileBuilder />);
    openAllGroups(view.container);
    expect(view.container.querySelectorAll('details:not([open])')).toHaveLength(0);
    // 不正な戻り先 URL の検証文・非 https の警告・埋め込みの切り替えが出ている状態を固定する。
    expect(screen.getByRole('textbox', { name: /^チップ後に表示するリンク/ })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('claim').getAttribute('data-blocked')).not.toBe('');
    expect(payload()).toMatchInlineSnapshot(`
      {
        "config": {
          "color": "#ef4444",
          "message": "Hi",
          "methods": [
            {
              "chain": "polygon",
              "token": "jpyc",
            },
            {
              "chain": "base",
              "crossChain": true,
              "token": "usdc",
            },
          ],
          "name": "Alice",
          "presets": {
            "jpyc": [
              "300",
              "1000",
              "3000",
            ],
          },
          "thanks": "Thanks!",
          "thanksUrl": "foo",
          "theme": "gradient",
          "to": "0x52d4901142e2B5680027da5EB47C86CB02a3cA81",
        },
        "profile": {
          "avatar": "https://images.example/avatar.png",
          "bio": "Hello there",
          "cover": "https://images.example/cover.png",
          "font": "serif",
          "linkLayout": "grid",
          "links": [
            {
              "emoji": "📝",
              "featured": true,
              "imageUrl": "https://images.example/blog.png",
              "label": "Blog",
              "url": "https://blog.example",
            },
            {
              "kind": "heading",
              "label": "Music",
            },
            {
              "embed": true,
              "label": "Video",
              "url": "https://youtu.be/dQw4w9WgXcQ",
            },
          ],
          "socials": [
            "https://x.com/alice",
          ],
          "theme": "gradient",
        },
      }
    `);
    expect(hashDom(view.container)).toMatchInlineSnapshot(`
      {
        "all": "a885efbe09c7a101254d3d6f3fdd702acb1ef3be9cb449ac885baba9db948a30",
        "parts": [
          "div e572fc673e59 Alice@handleプレビュ",
          "div 4d961ae8963d あなたのページ",
          "section e33c93e48f30 受け取り設定0x52d4…cA8",
          "section 88542610f02a プロフィール表示名ひとこと (b",
          "aside 86a5eeafc144 プレビューAliceHello ",
          "div c4770e3ba873 bar",
        ],
      }
    `);
  });

  it('pins the receive settings sheet (Arc ON・Avalanche ON・旧レコードの Base+Arc 両方 / Arc OFF の Arc 下書き)', () => {
    h.arc = true;
    h.enableJpycAvalanche = true;
    seed({ to: ADDR, jpycAvalanche: true, usdcBase: true, usdcArc: true });
    const both = renderWithIntl(<HandleProfileBuilder />);
    openReceiveSettings();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const arcOn = hashDom(both.container);
    both.unmount();
    h.arc = false;
    h.enableJpycAvalanche = false;
    seed({ to: 'alice.eth', usdcArc: true });
    const inactive = renderWithIntl(<HandleProfileBuilder />);
    openReceiveSettings();
    expect(within(screen.getByRole('dialog')).getByRole('radio', { name: /USDC \(Arc/ })).toBeDisabled();
    expect({ arcOn, arcOff: hashDom(inactive.container) }).toMatchInlineSnapshot(`
      {
        "arcOff": {
          "all": "366c7749629ecf07eabb9fc7d9c1836d4a6bc70bae11fec0ba6d174d45423e87",
          "parts": [
            "div 9e9d4e13728d H@handleプレビューへ",
            "div 964b21187ca4 あなたのページ",
            "section abb6c7e86add 受け取り設定0x52d4…cA8",
            "div 89f0dd2b1244 受け取りの設定完了受け取り受取先",
            "section 3bb42c07083e プロフィール表示名ひとこと (b",
            "aside 6b9c8d3be6c2 プレビュー@無効中（点灯待ち）通",
            "div c4770e3ba873 bar",
          ],
        },
        "arcOn": {
          "all": "1e02cc42643bdb2064a3ed928c0adf180ca1e550fde17cc15ac34afc7e12b1fa",
          "parts": [
            "div 9e9d4e13728d H@handleプレビューへ",
            "div bbd7c17af677 あなたのページ",
            "section 8da7cfb22d4b 受け取り設定0x52d4…cA8",
            "div 9d36e6033341 受け取りの設定完了受け取り受取先",
            "section 3bb42c07083e プロフィール表示名ひとこと (b",
            "aside 245f5922d1c5 プレビュー@通貨・チェーンを選ぶ",
            "div c4770e3ba873 bar",
          ],
        },
      }
    `);
  });

  it('pins the DOM through editing → dirty → copied → QR → published → stop editing', async () => {
    seed({ name: '編集前の下書き', bio: '未公開のメモ' });
    const view = renderWithIntl(<HandleProfileBuilder />);
    fireEvent.click(screen.getByTestId('edit-named'));
    const editing = hashDom(view.container);
    fireEvent.change(screen.getByLabelText('表示名'), { target: { value: 'Draft Alice' } });
    expect(screen.getByTestId('claim')).toHaveAttribute('data-dirty', 'true');
    const dirty = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'コピー' }));
    await screen.findByRole('button', { name: 'コピー済み' });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://test.local/@alice');
    const copied = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: 'QRコード' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('https://test.local/@alice');
    const qr = hashDom(view.container);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    fireEvent.click(screen.getByTestId('publish-mock'));
    expect(screen.getByTestId('claim')).toHaveAttribute('data-dirty', 'false');
    const published = hashDom(view.container);
    fireEvent.click(screen.getByTestId('stop-mock'));
    expect(screen.getByLabelText('表示名')).toHaveValue('編集前の下書き');
    const stopped = hashDom(view.container);
    expect({ editing, dirty, copied, qr, published, stopped }).toMatchInlineSnapshot(`
      {
        "copied": {
          "all": "695d2f2ff2165fcca6a9ea2122b540a27b24b422ed9954a481cfbd24902229cc",
          "parts": [
            "div 8af3385c7fc6 DDraft Alice@ali",
            "div 025d4c8b1f90 あなたのページ公開中 @alic",
            "section e69acd147450 受け取り設定0x52d4…cA8",
            "section 38023d5bdfe6 プロフィール表示名ひとこと (b",
            "aside 25dd4cee569a プレビューDDraft Alic",
            "div c4770e3ba873 bar",
          ],
        },
        "dirty": {
          "all": "8dfd0d349e17f5669b54ec95cc121f06acf1995546cd31e5bfb312f0c09b2e55",
          "parts": [
            "div 8af3385c7fc6 DDraft Alice@ali",
            "div 025d4c8b1f90 あなたのページ公開中 @alic",
            "section e69acd147450 受け取り設定0x52d4…cA8",
            "section 38023d5bdfe6 プロフィール表示名ひとこと (b",
            "aside 0cb2e3a41b82 プレビューDDraft Alic",
            "div c4770e3ba873 bar",
          ],
        },
        "editing": {
          "all": "6bc05e405f314b9e596e2490d16af13c607345318c9dc7827af753f4fa3c68a5",
          "parts": [
            "div 3ac97aa67a71 PPublished Alice",
            "div 51ff661a267b あなたのページ公開中 @alic",
            "section e69acd147450 受け取り設定0x52d4…cA8",
            "section fab4d285c5b6 プロフィール表示名ひとこと (b",
            "aside 588577c98da1 プレビューPPublished ",
            "div c4770e3ba873 bar",
          ],
        },
        "published": {
          "all": "44a2a0225b64fb0a0bd8125cc540ac00d229b46b8cd07b2584d9ebe7159b7952",
          "parts": [
            "div 8af3385c7fc6 DDraft Alice@ali",
            "div 7c3739761c38 あなたのページ公開中 @alic",
            "section e69acd147450 受け取り設定0x52d4…cA8",
            "section 38023d5bdfe6 プロフィール表示名ひとこと (b",
            "aside 4888aa6b5350 プレビューDDraft Alic",
            "div c4770e3ba873 bar",
          ],
        },
        "qr": {
          "all": "69968482498e49a11528a3dce25a223b9e1671391bdf309810c71d4b8ef89702",
          "parts": [
            "div 8af3385c7fc6 DDraft Alice@ali",
            "div 025d4c8b1f90 あなたのページ公開中 @alic",
            "section e69acd147450 受け取り設定0x52d4…cA8",
            "section 38023d5bdfe6 プロフィール表示名ひとこと (b",
            "aside 25dd4cee569a プレビューDDraft Alic",
            "div c4770e3ba873 bar",
            "div b1735403fe57 @alicehttps://te",
          ],
        },
        "stopped": {
          "all": "dcdf895ac406a814ac00e984c4cf2ed731a97645fda90c97e30188e65750473a",
          "parts": [
            "div a51e0d185cc4 編編集前の下書き@handleプ",
            "div 346cda5c9257 あなたのページ",
            "section 6de4a6114b18 受け取り設定受取先 (全方法 共",
            "section c2d5243d01e6 プロフィール表示名ひとこと (b",
            "aside 5772758a16b8 プレビュー編編集前の下書き未公開",
            "div c4770e3ba873 bar",
          ],
        },
      }
    `);
  });

  it('子 component に分けても入力欄・折りたたみ・画像の失敗状態を作り直さない (node の同一性と focus)', async () => {
    seed({ ...RICH_DRAFT, thanksUrl: 'https://example.com/thanks' });
    const view = renderWithIntl(<HandleProfileBuilder />);
    openAllGroups(view.container);
    const mini = screen.getByTestId('handle-mini-preview');
    const avatarImg = () => mini.querySelector('img[src$="avatar.png"]');
    fireEvent.error(avatarImg()!);
    expect(avatarImg()).toBeNull();
    const details = [...view.container.querySelectorAll('details')];
    const fields = () => ({
      name: screen.getByLabelText('表示名'),
      bio: screen.getByLabelText(/ひとこと/),
      color: screen.getByPlaceholderText('#2563eb'),
      cover: screen.getByRole('textbox', { name: /^カバー画像 URL/ }),
      social: screen.getAllByPlaceholderText('https://x.com/yourname')[0],
      linkLabel: screen.getAllByRole('textbox', { name: 'ラベル' })[0],
      heading: screen.getByRole('textbox', { name: '見出し' }),
      linkUrl: screen.getAllByRole('textbox', { name: 'URL' })[0],
      message: screen.getByLabelText(/^メッセージ \(任意\)/),
      thanksUrl: screen.getByRole('textbox', { name: /^チップ後に表示するリンク/ }),
    });
    const before = fields();
    for (const key of Object.keys(before) as Array<keyof typeof before>) {
      const node = before[key];
      node.focus();
      fireEvent.change(node, { target: { value: `${(node as HTMLInputElement).value}x` } });
      expect(fields()[key]).toBe(node);
      expect(node).toHaveFocus();
    }
    expect([...view.container.querySelectorAll('details')]).toEqual(details);
    expect(details.every((d) => d.open)).toBe(true);
    // ミニプレビューのアバターの失敗状態は、無関係な入力の再描画で消えない (頭文字のまま)。
    expect(avatarImg()).toBeNull();
    // 受け取りのシートの入力欄も、打っている間に作り直さない。
    openReceiveSettings();
    const sheetInput = within(screen.getByRole('dialog')).getByTestId('addr');
    sheetInput.focus();
    fireEvent.change(sheetInput, { target: { value: ADDR2 } });
    expect(within(screen.getByRole('dialog')).getByTestId('addr')).toBe(sheetInput);
    expect(sheetInput).toHaveFocus();
    await waitFor(() => expect(payload().config.to).toBe(ADDR2));
  });
});
