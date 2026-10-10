import { expect, type Page } from '@playwright/test';

const TIP_SETTINGS_KEY = 'openpay:tip-settings:v2';

// /create の「チップ」タブを開き、保存済みの設定の読み込みが済むまで待つ (新しい context = 保存済みの設定が無い前提)。
// TipEmbedGenerator は next/dynamic (ssr:false) で、タブを押してから mount される。mount の直後は既定の設定で描かれ、
// 保存済みの設定は mount 後の effect (useLocalStorageSettings) が丸ごと置き換える。その effect より前に届いた入力
// (受取先・通貨の選択など) は置き換えで消える (入力欄が空に戻り、受取先の無いまま URL も ENS の解決も出ない)。
// CI の WebKit では入力欄が見えてから effect までの間に fill が入り、retry 頼みになっていた。
// effect が済むと設定が localStorage に書かれる (hydrated 後だけ書く) ので、それを待ってから操作する。
export async function openTipTab(page: Page, path = '/ja/create'): Promise<void> {
  await page.goto(path);
  // 保存済みの設定があると、下の待ちが読み込みの前に通ってしまう。前提が崩れたら分かるように確かめる。
  expect(
    await page.evaluate((key) => window.localStorage.getItem(key), TIP_SETTINGS_KEY),
    'openTipTab は保存済みのチップ設定が無い context で使う',
  ).toBeNull();
  // タブラベルは短縮済み (旧「Tip widget (クリエイター)」→「チップ」)。
  await page.getByRole('button', { name: 'チップ' }).click();
  // 見出しはタブ名に任せる (2026-10 磨き上げ P4)。最初のカード「受け取り」で開いたことを確かめる。
  await expect(page.getByRole('heading', { name: '受け取り', exact: true })).toBeVisible();
  await page.waitForFunction(
    (key) => window.localStorage.getItem(key) !== null,
    TIP_SETTINGS_KEY,
    { timeout: 15_000 },
  );
}
