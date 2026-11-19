// 画像のアップロード PR 3B の部品: 欄ごとの操作の番号と失効 (useImageFieldOperations)・画像の欄を出すか (imageUploadScopeOf)・
// アップロード中の欄の集まり (useImageBusyKeys)・1 つのキーに一覧が入った設定の書き込みで、このタブの画像の変更だけを最新の
// 一覧に重ねる rebase (hooks/useLocalStorageSettings の rebaseRowField・rules.rebase)。
import { describe, expect, it } from 'vitest';
import { act, render, renderHook } from '@testing-library/react';
import { useState } from 'react';
import {
  IMAGE_UPLOAD_OFF,
  imageUploadScopeOf,
  nextImageOperation,
  useImageBusyKeys,
  useImageFieldOperations,
} from '@/hooks/useImageUpload';
import { rebaseRowField, useLocalStorageSettings, type SettingsSyncRules } from '@/hooks/useLocalStorageSettings';

const ADDR = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';

describe('imageUploadScopeOf', () => {
  it('サインイン済みで imageUpload のときだけ upload (本人のアドレスで key が変わる)', () => {
    expect(imageUploadScopeOf({ isSignedIn: true, sessionAddress: ADDR, imageUpload: true })).toEqual({
      access: 'upload',
      key: `upload:${ADDR.toLowerCase()}`,
    });
    expect(imageUploadScopeOf({ isSignedIn: true, sessionAddress: '0x000000000000000000000000000000000000dEaD', imageUpload: true }).key).not.toBe(
      `upload:${ADDR.toLowerCase()}`,
    );
  });

  it.each([
    ['サインイン済みで imageUpload が false', { isSignedIn: true, sessionAddress: ADDR, imageUpload: false, imageUploadSignIn: true }],
    ['imageUpload が無い (古い mock・段階 off)', { isSignedIn: true, sessionAddress: ADDR }],
    ['サインインしていない・imageUploadSignIn も無い', { isSignedIn: false, sessionAddress: null }],
    ['サインインしていないのに imageUpload だけ true (別のウォレットのセッション)', { isSignedIn: false, sessionAddress: null, imageUpload: true }],
  ])('%s は off', (_label, session) => {
    expect(imageUploadScopeOf(session)).toEqual(IMAGE_UPLOAD_OFF);
  });

  it('サインインしていなくて imageUploadSignIn なら signIn', () => {
    expect(imageUploadScopeOf({ isSignedIn: false, sessionAddress: null, imageUploadSignIn: true })).toEqual({ access: 'signIn', key: 'signIn' });
  });
});

describe('useImageFieldOperations', () => {
  it('scope が替わったら (描画の確定で) 全部の欄の番号を進め、同じ scope では進めない', () => {
    const { result, rerender } = renderHook(({ scope }) => useImageFieldOperations(scope), { initialProps: { scope: 'off' } });
    const avatar = result.current.operation('avatar');
    const cover = result.current.operation('cover');
    const started = nextImageOperation(avatar);
    rerender({ scope: 'off' });
    expect(avatar.current).toBe(started);
    rerender({ scope: `upload:${ADDR}` });
    expect(avatar.current).toBe(started + 1);
    expect(cover.current).toBe(1);
    // 同じ key の欄は同じ番号 (描画をまたいでも)。
    expect(result.current.operation('avatar')).toBe(avatar);
  });

  it('advance はその欄だけ、advanceAll は全部の欄を進める。外れる (unmount) ときも全部進める', () => {
    const { result, unmount } = renderHook(() => useImageFieldOperations('off'));
    const a = result.current.operation('a');
    const b = result.current.operation('b');
    result.current.advance('a');
    expect([a.current, b.current]).toEqual([1, 0]);
    result.current.advanceAll();
    expect([a.current, b.current]).toEqual([2, 1]);
    unmount();
    expect([a.current, b.current]).toEqual([3, 2]);
  });
});

describe('useImageBusyKeys', () => {
  it('1 つでも送っていれば busy・key ごとに外す (作り直す前の欄の false は、作り直した欄の印を消さない)', () => {
    const { result } = renderHook(() => useImageBusyKeys());
    act(() => result.current.setBusy('g1:avatar', true));
    act(() => result.current.setBusy('g2:avatar', true));
    act(() => result.current.setBusy('g1:avatar', false));
    expect(result.current.busy).toBe(true);
    expect([...result.current.keys]).toEqual(['g2:avatar']);
    act(() => result.current.setBusy('g2:avatar', false));
    expect(result.current.busy).toBe(false);
  });
});

type Row = { id: string; name: string; image?: string };
const rebaseImage = rebaseRowField<Row>('image');

describe('rebaseRowField (画像だけを最新の一覧に重ねる)', () => {
  const base: Row[] = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];

  it('このタブで画像だけを変えたら、最新の一覧の同じ id の行の画像だけを替える (別のタブの改名・並べ替え・削除・追加が残る)', () => {
    const local = [base[0], base[1], { ...base[2], image: 'https://x/c.jpg' }];
    const latest = [{ id: 'd', name: 'D' }, { id: 'c', name: 'C2' }, { id: 'a', name: 'A2' }];
    expect(rebaseImage(local, base, latest)).toEqual([{ id: 'd', name: 'D' }, { id: 'c', name: 'C2', image: 'https://x/c.jpg' }, { id: 'a', name: 'A2' }]);
  });

  it('外した (undefined) 画像も重ねる・消えた行には入れない', () => {
    const withImage = base.map((row) => ({ ...row, image: `https://x/${row.id}.jpg` }));
    const local = [{ id: 'a', name: 'A' }, withImage[1], { ...withImage[2], image: 'https://x/new.jpg' }];
    const latest = [withImage[0], withImage[1]];
    expect(rebaseImage(local, withImage, latest)).toEqual([{ id: 'a', name: 'A' }, withImage[1]]);
  });

  it('別のタブも同じ行の画像を替えていたら、保存済みの値を残す', () => {
    const local = [{ ...base[0], image: 'https://x/mine.jpg' }, base[1], base[2]];
    const latest = [{ ...base[0], image: 'https://x/other.jpg' }, base[1], base[2]];
    expect(rebaseImage(local, base, latest)).toEqual(latest);
  });

  it.each([
    ['名前も変えた', [{ ...base[0], name: 'A!', image: 'https://x/a.jpg' }, base[1], base[2]]],
    ['並べ替えた', [base[1], base[0], base[2]]],
    ['行を足した', [...base, { id: 'z', name: 'Z' }]],
    ['行を消した', [base[0], base[1]]],
    ['何も変えていない', base],
  ])('このタブで画像以外も変えた (%s) なら重ねない (null = 今までどおりこのタブの一覧で書く)', (_label, local) => {
    expect(rebaseImage(local as Row[], base, [{ id: 'q', name: 'Q' }])).toBeNull();
  });

  it('形が読めない保存値なら重ねない', () => {
    const local = [{ ...base[0], image: 'https://x/a.jpg' }, base[1], base[2]];
    expect(rebaseImage(local, base, 'broken')).toBeNull();
    expect(rebaseImage(local, base, [{ name: 'no id' }])).toBeNull();
    expect(rebaseImage(local, 'broken', base)).toBeNull();
  });
});

type ListStore = { rows: Row[]; note: string };
const KEY = 'test:rebase-list';
const sanitizeList = (loaded: Partial<ListStore>): ListStore => ({
  rows: Array.isArray(loaded.rows) ? loaded.rows : [],
  note: typeof loaded.note === 'string' ? loaded.note : '',
});
const DEFAULT_LIST: ListStore = { rows: [], note: '' };
const RULES: SettingsSyncRules<ListStore> = { rebase: { rows: rebaseRowField<Row>('image') } };
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? 'null') as ListStore;

describe('useLocalStorageSettings の rules.rebase', () => {
  function Harness({ rules, hold }: { rules?: SettingsSyncRules<ListStore>; hold: boolean }) {
    const { settings, setSettings, hydrated } = useLocalStorageSettings<ListStore>(KEY, DEFAULT_LIST, sanitizeList, rules, hold);
    const [, force] = useState(0);
    return (
      <>
        <output data-testid="rows">{hydrated ? JSON.stringify(settings.rows) : ''}</output>
        <button
          type="button"
          onClick={() => {
            setSettings((s) => ({ ...s, rows: s.rows.map((row) => (row.id === 'b' ? { ...row, image: 'https://x/b.jpg' } : row)) }));
            force((n) => n + 1);
          }}
        >
          image
        </button>
      </>
    );
  }

  function setup(rules?: SettingsSyncRules<ListStore>) {
    localStorage.setItem(KEY, JSON.stringify({ rows: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], note: '' }));
    const view = render(<Harness rules={rules} hold />);
    // 別のタブが A を改名して保存した (このタブは取り込みを保留している)。
    localStorage.setItem(KEY, JSON.stringify({ rows: [{ id: 'a', name: 'A2' }, { id: 'b', name: 'B' }], note: 'other' }));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    act(() => {
      view.getByRole('button', { name: 'image' }).click();
    });
    return view;
  }

  it('別のタブが書き換えた一覧に、このタブの画像だけを重ねて書き、画面にも書いた一覧を出す', () => {
    const view = setup(RULES);
    expect(stored().rows).toEqual([{ id: 'a', name: 'A2' }, { id: 'b', name: 'B', image: 'https://x/b.jpg' }]);
    expect(stored().note).toBe('other');
    expect(JSON.parse(view.getByTestId('rows').textContent ?? '[]')).toEqual(stored().rows);
  });

  it('rebase の無い設定は今までどおり (このタブの一覧で書く)', () => {
    setup(undefined);
    expect(stored().rows).toEqual([{ id: 'a', name: 'A' }, { id: 'b', name: 'B', image: 'https://x/b.jpg' }]);
  });
});
