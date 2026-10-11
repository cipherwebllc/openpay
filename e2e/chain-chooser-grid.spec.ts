import { test, expect, type Locator, type Page } from '@playwright/test';

// jsdom では CSS が計算されないので grid 列数の regression は e2e でしか取れない。
// 列数の判定: 全 button の上端の y を 5px 粒度で round → unique 数 == 行数。
//
// このファイルは描画の frame を待つ操作 (click の stable 待ち・waitForFunction の raf polling) を使わない。
// CI の mobile-safari では、このファイルが WebKit の project の最初に 4 worker の同時起動の中で走る。そこでは JS は
// すぐ動くのに WebKit が数秒に 1 枚しか frame を出さず、click 1 回の stable 待ちに 2〜13 秒かかっていた。チップの
// タブの click・設定の読み込み待ち・USDC の click を重ねた test は 30 秒の timeout を使い切って落ちていた
// (2026-10 の CI で約 380 run 中 50 回。落ちた回はすべて timeout で、通った回も 16〜29 秒かかっていた)。
// - 通貨は保存済みの設定で USDC にしておき、USDC は押さない (通貨の切り替えは create.spec / tip-generator.spec が見る)。
// - チップのタブは deep-link (?tab=tip) で開く。お店の設定のシートは、読み込みが済んでから click の event を送って開く
//   (ボタンを押して開くことは create.spec の設定のシートの test が見る)。

// 保存済みの設定として通貨だけを置く (他の項目は読み込みの sanitize が既定で埋める)。
async function seedUsdcSettings(page: Page, storageKey: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify({ token: 'usdc' })],
  );
}

// 全 button の位置は 1 回の evaluate でまとめて読む (同じ瞬間のレイアウトを比べる。1 個ずつ読むと読むたびに
// WebKit の main thread が空くのを待ち、その間にレイアウトが動けば同じ行のボタンが別の行に数えられる)。
async function getRowsAndCols(locator: Locator): Promise<{
  rows: number;
  maxColsPerRow: number;
  total: number;
}> {
  const tops = await locator.evaluateAll((buttons) =>
    buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 ? rect.top : null;
    }),
  );
  const yByRow = new Map<number, number>();
  tops.forEach((top, i) => {
    if (top === null) throw new Error(`button ${i} has no bounding box`);
    // 1px の rendering 誤差を許容 (Tailwind の gap-2 = 8px なので 5px buffer で十分)
    const yKey = Math.round(top / 5) * 5;
    yByRow.set(yKey, (yByRow.get(yKey) ?? 0) + 1);
  });
  const counts = Array.from(yByRow.values());
  return {
    rows: counts.length,
    maxColsPerRow: Math.max(...counts),
    total: tops.length,
  };
}

const CHAIN_BUTTONS =
  'div.grid.grid-cols-2:has(button[type="button"] img[src*="/chains/"]) > button';

test.describe('chain chooser grid 列数 (viewport 連動)', () => {
  test('QR generator: お店の設定の USDC 6 chain はどの画面幅でも 2 列 (シートの幅は最大 448px)', async ({
    page,
  }) => {
    await seedUsdcSettings(page, 'openpay:qr-settings:v2');
    await page.goto('/ja/create');
    // 会計画面の要約が保存済みの USDC のチェーンになったら、設定の読み込み (= hydrate) が済んでいる。
    await expect(page.getByText('Base Sepolia', { exact: true })).toBeVisible({ timeout: 15000 });

    // 2026-10 磨き上げ P2: 通貨とチェーンは「お店の設定」シートの中。
    await page.getByRole('button', { name: '設定', exact: true }).dispatchEvent('click');
    const sheet = page.getByRole('dialog', { name: 'お店の設定' });
    await expect(sheet).toBeVisible();

    // CI は Arc flag OFF で USDC は 6 chain (Base/Arbitrum 等)。
    const chainButtons = sheet.locator(CHAIN_BUTTONS);
    await expect(chainButtons).toHaveCount(6);

    const { rows, maxColsPerRow, total } = await getRowsAndCols(chainButtons);
    expect(total).toBe(6);
    expect(maxColsPerRow).toBe(2);
    expect(rows).toBe(3);
  });

  test('Tip widget generator: USDC chain chooser も同じ列数', async ({
    page,
    viewport,
  }) => {
    await seedUsdcSettings(page, 'openpay:tip-settings:v2');
    await page.goto('/ja/create?tab=tip');
    // TipEmbedGenerator は next/dynamic (ssr:false) で、タブが切り替わってから読み込まれ、保存済みの設定は mount 後の
    // effect が読む。読み込み前は既定の JPYC で描かれるので、USDC のチェーンの見出しが出るまで待つ
    // (hydrate・部品の読み込み・設定の読み込みを含むので、他の hydrate 待ちと同じ 15 秒)。
    await expect(page.getByText('受取チェーン (USDC)', { exact: true })).toBeVisible({ timeout: 15000 });

    // CI は Arc/Arc tip 両 flag OFF で USDC は 6 chain。
    const chainButtons = page.locator(CHAIN_BUTTONS);
    await expect(chainButtons).toHaveCount(6);

    const { maxColsPerRow } = await getRowsAndCols(chainButtons);
    const expectedCols = viewport!.width < 640 ? 2 : 3;
    expect(maxColsPerRow).toBe(expectedCols);
  });
});
