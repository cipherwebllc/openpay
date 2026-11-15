import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { DEFAULT_PROFILE_DRAFT } from '@/hooks/useHandleProfileDraft';
import { HANDLE_THEME_NAMES, handlePreviewBackground, type HandleTheme } from '@/lib/handleTheme';
import { myHandlesQueryKey, type OwnedHandle } from '@/lib/handleMine';

// トップの見本で選んだテーマと色 (`/create?tab=profile&theme=…&color=…`) を、プロフのタブが下書きに入れる
// (plans/lp-polish-2026-11.md P6)。claim panel は mock しない (本物の HandleClaimPanel の自動編集の流れで確かめる):
// 持っている @handle が 1 つの人は、一覧が cache 済みでも取得が遅れても、今までどおり自動で編集に入る。

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const ADDR2 = '0x000000000000000000000000000000000000dEaD';
const STORAGE_KEY = 'openpay:handle-profile-draft:v1';
const SEED_KEY = 'openpay:landing-look-seed:v1';
const VIOLET = '#7c3aed';
const h = vi.hoisted(() => ({
  connected: undefined as string | undefined,
  signedIn: false,
}));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, enableHandles: true } };
});
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.connected, isConnected: !!h.connected }),
}));
vi.mock('@/hooks/useSiweSession', () => ({
  useSiweSession: () => ({
    isSignedIn: h.signedIn,
    sessionAddress: h.signedIn ? h.connected : null,
    signIn: vi.fn(),
    isSigningIn: false,
    signInError: null,
  }),
}));
vi.mock('@/hooks/useOrigin', () => ({ useOrigin: () => 'https://test.local' }));
vi.mock('@/hooks/useResolveAddress', () => ({ useResolveAddress: () => ({ data: null }) }));
vi.mock('@/components/ConnectButton', () => ({
  ConnectButton: () => <button type="button">Connect wallet</button>,
}));
vi.mock('@/components/AddressInput', () => ({
  AddressInput: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <input data-testid="addr" value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import { HandleProfileBuilder } from '@/components/HandleProfileBuilder';

/** 公開中の @handle (見本とは違う見た目)。 */
const PUBLISHED: OwnedHandle = {
  handle: 'alice',
  config: { to: ADDR, name: 'Published Alice', color: '#059669', methods: [{ token: 'jpyc', chain: 'polygon' }] },
  profile: { theme: 'bold' },
  updatedAt: Date.UTC(2026, 10, 1),
};

/** GET /api/handle (持っている @handle の一覧)。release を渡すと、その Promise が解けるまで返さない (取得が遅れる)。 */
function stubMine(handles: OwnedHandle[], release?: Promise<void>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === '/api/handle') {
        await release;
        return new Response(JSON.stringify({ ok: true, handles, max: 3 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ ok: true, available: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function renderBuilder(cached?: OwnedHandle[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) qc.setQueryData(myHandlesQueryKey(ADDR), { handles: cached, max: 3 });
  return renderWithIntl(
    <QueryClientProvider client={qc}>
      <HandleProfileBuilder />
    </QueryClientProvider>,
  );
}

const pressed = (name: string) => screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';
const colorText = () => screen.getByPlaceholderText('#2563eb') as HTMLInputElement;
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>;
const url = () => `${window.location.pathname}${window.location.search}${window.location.hash}`;
/** このタブの見本の印 (sessionStorage)。下書き (localStorage) には入れない。 */
const seed = () => JSON.parse(sessionStorage.getItem(SEED_KEY) ?? 'null') as Record<string, unknown> | null;

/** このテーマと色で描いている (テーマの選択・色の欄・プレビューの地)。 */
async function expectLook(theme: HandleTheme, color: string) {
  await waitFor(() => expect(pressed(HANDLE_THEME_NAMES[theme])).toBe(true));
  expect(colorText().value).toBe(color);
  const scroll = screen.getByTestId('handle-preview-scroll');
  if (theme === 'clean') {
    expect(scroll.style.background).toBe('');
  } else {
    // jsdom が読めない値だと両辺とも空で一致してしまうので、地が入っていることも見る。
    expect(scroll.style.background).not.toBe('');
    expect(scroll).toHaveStyle({ background: handlePreviewBackground(color, theme) });
  }
}

beforeEach(() => {
  h.connected = undefined;
  h.signedIn = false;
  localStorage.clear();
  sessionStorage.clear();
  stubMine([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('プロフのタブ: トップの見本で選んだテーマと色で始める', () => {
  it('手付かずの下書きに入れて印を残し、URL から theme と color だけを消す (tab と hash は残す)・名前と受取先は変えない', async () => {
    window.history.replaceState(null, '', `/ja/create?tab=profile&theme=night&color=violet#handle-page-heading`);
    renderBuilder();
    await expectLook('night', VIOLET);
    expect(url()).toBe('/ja/create?tab=profile#handle-page-heading');
    await waitFor(() => expect(stored()).toMatchObject({ theme: 'night', color: VIOLET }));
    expect(stored()).toMatchObject({ name: '', to: '' });
    // 印はこのタブの sessionStorage にだけ残す (下書きの形は今のまま)。
    expect(Object.keys(stored()).sort()).toEqual(Object.keys(DEFAULT_PROFILE_DRAFT).sort());
    expect(seed()).toEqual({ theme: 'night', color: VIOLET });
    expect(screen.getByLabelText('表示名')).toHaveValue('');
    // 見本の値のままの下書きは手付かず: 何も触っていない新規の状態と同じく、ダミーのミニプレビューは出さない。
    expect(screen.queryByTestId('handle-mini-preview')).toBeNull();
  });

  it('見本で選んでいない (URL に無い) ときは今までどおり既定 (Clean) で始め、URL も下書きも触らない', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile#x');
    renderBuilder();
    await expectLook('clean', '#2563eb');
    expect(url()).toBe('/ja/create?tab=profile#x');
    await waitFor(() => expect(stored()).toMatchObject({ theme: 'clean' }));
    expect(seed()).toBeNull();
  });

  it('書きかけの下書き (名前を入れた) には入れない。URL の theme と color は消す', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: 'Alice', theme: 'soft' }));
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder();
    await waitFor(() => expect(url()).toBe('/ja/create?tab=profile'));
    expect(pressed('Soft')).toBe(true);
    expect(colorText().value).toBe('#2563eb');
    expect(screen.getByLabelText('表示名')).toHaveValue('Alice');
    expect(seed()).toBeNull();
  });

  it('片方だけ正しいときは、正しい方だけ入れる (色が不正ならテーマだけ)', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=black');
    renderBuilder();
    await expectLook('night', '#2563eb');
    expect(url()).toBe('/ja/create?tab=profile');
    await waitFor(() => expect(seed()).toEqual({ theme: 'night', color: '#2563eb' }));
  });

  it('片方だけ正しいときは、正しい方だけ入れる (テーマが不正なら色だけ)', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=neon&color=violet');
    renderBuilder();
    await expectLook('clean', VIOLET);
    await waitFor(() => expect(seed()).toEqual({ theme: 'clean', color: VIOLET }));
  });

  it('両方不正なら何も入れず、URL からは消す', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=xxx&color=%23000000');
    renderBuilder();
    await waitFor(() => expect(url()).toBe('/ja/create?tab=profile'));
    await expectLook('clean', '#2563eb');
    expect(seed()).toBeNull();
  });

  it('再読み込み・タブの往復で二重に入らない (URL から消してある)・変えたテーマはそのまま', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    const first = renderBuilder();
    await expectLook('night', VIOLET);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(stored()).toMatchObject({ theme: 'bold' }));
    // 見本の値と違う値になった時点で、このタブの印を消す。
    expect(seed()).toBeNull();
    first.unmount();
    renderBuilder();
    await expectLook('bold', VIOLET);
    // 見本の値から変えた下書きは、もう手付かずではない (ミニプレビューが出る)。
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });

  it('見本で選び直して来たら、見本の値のままの下書きは新しい値に入れ替える・変えた後の下書きには入れない', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    const first = renderBuilder();
    await expectLook('night', VIOLET);
    first.unmount();
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=bold&color=green');
    const second = renderBuilder();
    await expectLook('bold', '#059669');
    await waitFor(() => expect(seed()).toEqual({ theme: 'bold', color: '#059669' }));
    fireEvent.click(screen.getByRole('button', { name: 'Soft' }));
    await waitFor(() => expect(stored()).toMatchObject({ theme: 'soft' }));
    second.unmount();
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder();
    await waitFor(() => expect(url()).toBe('/ja/create?tab=profile'));
    await expectLook('soft', '#059669');
  });

  it('接続中 (サインインなし): 受取先は接続中のウォレットのまま (見本の値は受取先を変えない)', async () => {
    h.connected = ADDR;
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder();
    await expectLook('night', VIOLET);
    await waitFor(() => expect(stored()).toMatchObject({ to: ADDR, theme: 'night', color: VIOLET }));
    expect(seed()).toEqual({ theme: 'night', color: VIOLET });
  });

  it('別の受取先を打った下書きには入れず、受取先も変えない', async () => {
    h.connected = ADDR;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ to: ADDR2 }));
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder();
    await waitFor(() => expect(url()).toBe('/ja/create?tab=profile'));
    await expectLook('clean', '#2563eb');
    expect(stored()).toMatchObject({ to: ADDR2 });
    expect(seed()).toBeNull();
  });
});

describe('持っている @handle が 1 つの人 (本物の HandleClaimPanel): 見本の値を入れても、今までどおり自動で編集に入る', () => {
  beforeEach(() => {
    h.connected = ADDR;
    h.signedIn = true;
  });

  it('一覧が cache 済み: 公開中の内容で編集に入る。「編集をやめる」と、見本の見た目の下書きに戻る', async () => {
    stubMine([PUBLISHED]);
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder([PUBLISHED]);
    expect(await screen.findByTestId('published-status')).toBeInTheDocument();
    await expectLook('bold', '#059669');
    expect(screen.getByLabelText('表示名')).toHaveValue('Published Alice');
    expect(url()).toBe('/ja/create?tab=profile');
    // 公開中の内容を読み込んだので、このタブの印は消す。
    expect(seed()).toBeNull();
    // 編集に入る前の下書き (見本の見た目で始めた下書き) を復元する = 見本の値を入れてから自動編集に入った。
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    await expectLook('night', VIOLET);
    expect(screen.getByLabelText('表示名')).toHaveValue('');
    // 戻した下書きは、手を入れたものと数える (印は消してある)。
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });

  it('一覧の取得が遅れる: 先に見本の見た目で始め、一覧が届いたら公開中の内容で編集に入る', async () => {
    let release!: () => void;
    stubMine([PUBLISHED], new Promise<void>((resolve) => { release = resolve; }));
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder();
    await expectLook('night', VIOLET);
    expect(screen.queryByTestId('published-status')).toBeNull();
    release();
    expect(await screen.findByTestId('published-status')).toBeInTheDocument();
    await expectLook('bold', '#059669');
    expect(screen.getByLabelText('表示名')).toHaveValue('Published Alice');
  });

  it('公開中の内容が既定の見た目でも、読み込んだ後に見本の値を重ねない', async () => {
    const plain: OwnedHandle = { ...PUBLISHED, config: { to: ADDR, methods: [{ token: 'jpyc', chain: 'polygon' }, { token: 'jpyc', chain: 'kaia' }] }, profile: undefined };
    stubMine([plain]);
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder([plain]);
    expect(await screen.findByTestId('published-status')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 0));
    await expectLook('clean', '#2563eb');
    expect(seed()).toBeNull();
  });

  it('書きかけの下書きがあるときは、見本の値も入れず、自動で編集にも入らない (今までどおり)', async () => {
    stubMine([PUBLISHED]);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: '未公開の名前' }));
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder([PUBLISHED]);
    await waitFor(() => expect(url()).toBe('/ja/create?tab=profile'));
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('published-status')).toBeNull();
    await expectLook('clean', '#2563eb');
    expect(screen.getByLabelText('表示名')).toHaveValue('未公開の名前');
  });
});

describe('見本の印はタブごと (sessionStorage) に持つ', () => {
  it('再 mount・再読み込みでも、このタブの印は残る (見本の値のままなら手付かずのまま)', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    const first = renderBuilder();
    await expectLook('night', VIOLET);
    first.unmount();
    renderBuilder();
    await expectLook('night', VIOLET);
    expect(seed()).toEqual({ theme: 'night', color: VIOLET });
    expect(screen.queryByTestId('handle-mini-preview')).toBeNull();
  });

  it('値が印と食い違ったら印を消し、後で同じ値に戻しても手付かずとは数えない', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder();
    await expectLook('night', VIOLET);
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(seed()).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    await expectLook('night', VIOLET);
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });

  it('壊れた印 (sessionStorage) は印なしとして読む', async () => {
    for (const bad of ['{', '"night"', 'null', JSON.stringify({ theme: 'neon', color: VIOLET }), JSON.stringify({ theme: 'night', color: 'violet' })]) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: 'night', color: VIOLET }));
      sessionStorage.setItem(SEED_KEY, bad);
      const view = renderBuilder();
      await expectLook('night', VIOLET);
      // 印が無いので、見本の値の入った下書きは手を入れたもの (ミニプレビューが出る)。
      expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
      view.unmount();
    }
  });

  it('sessionStorage が使えない環境でも描画を止めず、見本の値は入る (再読み込みの後は、手を入れたものと数える)', async () => {
    vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    const first = renderBuilder();
    await expectLook('night', VIOLET);
    expect(url()).toBe('/ja/create?tab=profile');
    // このタブの今の描画の間は、state の印で手付かず。
    expect(screen.queryByTestId('handle-mini-preview')).toBeNull();
    first.unmount();
    renderBuilder();
    await expectLook('night', VIOLET);
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });

  /** sessionStorage の setItem か removeItem だけを失敗させる (localStorage の下書きの保存はそのまま)。 */
  function failSessionStorage(method: 'setItem' | 'removeItem') {
    const original = Storage.prototype[method];
    vi.spyOn(Storage.prototype, method).mockImplementation(function (this: Storage, ...args: [string, string]) {
      if (this === window.sessionStorage) throw new DOMException('quota', 'QuotaExceededError');
      return (original as (...a: [string, string]) => void).apply(this, args);
    });
  }

  it('印の書き込み (setItem) だけ失敗: 今の mount の間は手付かず、再 mount の後は手を入れたものと数える', async () => {
    failSessionStorage('setItem');
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    const first = renderBuilder();
    await expectLook('night', VIOLET);
    expect(seed()).toBeNull();
    // 下書き (localStorage) は保存できている。
    await waitFor(() => expect(stored()).toMatchObject({ theme: 'night', color: VIOLET }));
    expect(screen.queryByTestId('handle-mini-preview')).toBeNull();
    first.unmount();
    renderBuilder();
    await expectLook('night', VIOLET);
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });

  it('印の削除 (removeItem) だけ失敗: 残った古い印は、今の値と違えば読んだ後すぐ消し、手付かずと数えない', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    const first = renderBuilder();
    await expectLook('night', VIOLET);
    failSessionStorage('removeItem');
    fireEvent.click(screen.getByRole('button', { name: 'Bold' }));
    await waitFor(() => expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument());
    // 消せなかったので、古い印が sessionStorage に残る。
    expect(seed()).toEqual({ theme: 'night', color: VIOLET });
    first.unmount();
    // 再 mount: 古い印を読むが、今の値 (Bold) と違うので手付かずではない。
    const second = renderBuilder();
    await expectLook('bold', VIOLET);
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
    // この mount の間に偶然同じ値 (Night) へ戻しても、読んだ印は消してあるので手付かずではない。
    fireEvent.click(screen.getByRole('button', { name: 'Night' }));
    await expectLook('night', VIOLET);
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
    second.unmount();
    // さらに再 mount すると、残った古い印と今の値が偶然同じで、ほかが既定なので手付かずと数える (値だけでは区別できない・
    // 受け入れている場合と同じ)。
    renderBuilder();
    await expectLook('night', VIOLET);
    expect(screen.queryByTestId('handle-mini-preview')).toBeNull();
  });

  it('別のタブ (B) が見本の値を入れても、手で選んだ値が未保存のまま前面に戻ったタブ (A) は手付かずにならない', async () => {
    // A は先に開いていたタブ (印なし)。B は見本の Bold × 緑で開いたタブ。
    window.history.replaceState(null, '', '/ja/create?tab=profile');
    const a = within(renderBuilder().container);
    await waitFor(() => expect(a.getByRole('button', { name: 'Clean' })).toHaveAttribute('aria-pressed', 'true'));
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=bold&color=green');
    const b = within(renderBuilder().container);
    await waitFor(() => expect(b.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true'));
    expect(b.queryByTestId('handle-mini-preview')).toBeNull();
    // A で手で Bold を選び、保存の前に A が前面に戻る (B の緑を取り込む)。
    act(() => {
      fireEvent.click(a.getByRole('button', { name: 'Bold' }));
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect((a.getByPlaceholderText('#2563eb') as HTMLInputElement).value).toBe('#059669'));
    expect(a.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
    // A の手入力の入った下書きは手付かずではない (ミニプレビューが出る = 持っている @handle の自動編集にも入らない)。
    expect(a.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });
});

describe('見本の印を入れ替える・消す時機', () => {
  it('このタブの古い印が今の下書きと食い違っていても、選び直して来た見本の新しい印は残す', async () => {
    // 古い印 (Night × 紫) の後に、別のタブで下書きが既定へ戻されていた。そこへ Bold × 緑で来た。
    sessionStorage.setItem(SEED_KEY, JSON.stringify({ theme: 'night', color: VIOLET }));
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=bold&color=green');
    renderBuilder();
    await expectLook('bold', '#059669');
    await waitFor(() => expect(seed()).toEqual({ theme: 'bold', color: '#059669' }));
    expect(screen.queryByTestId('handle-mini-preview')).toBeNull();
  });

  it('公開中の内容が見本と同じ見た目でも、自動編集に入ったら印を消す (編集をやめて戻した下書きは手を入れたもの)', async () => {
    h.connected = ADDR;
    h.signedIn = true;
    const same: OwnedHandle = { ...PUBLISHED, config: { ...PUBLISHED.config, color: VIOLET }, profile: { theme: 'night' } };
    stubMine([same]);
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&color=violet');
    renderBuilder([same]);
    expect(await screen.findByTestId('published-status')).toBeInTheDocument();
    await waitFor(() => expect(seed()).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: '編集をやめる' }));
    await expectLook('night', VIOLET);
    expect(screen.getByTestId('handle-mini-preview')).toBeInTheDocument();
  });
});

describe('重なった query', () => {
  it('同じ名前が重なったときは先頭の値を採る (Night × 赤)', async () => {
    window.history.replaceState(null, '', '/ja/create?tab=profile&theme=night&theme=bold&color=rose&color=green');
    renderBuilder();
    await expectLook('night', '#e11d48');
    expect(url()).toBe('/ja/create?tab=profile');
  });
});
