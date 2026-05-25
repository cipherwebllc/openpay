import { test, expect, type Locator } from '@playwright/test';

// jsdom では CSS が計算されないので grid 列数の regression は e2e でしか取れない。
// 列数の判定: 全 button の boundingBox().y を 5px 粒度で round → unique 数 == 行数。

async function getRowsAndCols(locator: Locator): Promise<{
  rows: number;
  maxColsPerRow: number;
  total: number;
}> {
  const count = await locator.count();
  const yByRow = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const box = await locator.nth(i).boundingBox();
    if (!box) throw new Error(`button ${i} has no bounding box`);
    // 1px の rendering 誤差を許容 (Tailwind の gap-2 = 8px なので 5px buffer で十分)
    const yKey = Math.round(box.y / 5) * 5;
    yByRow.set(yKey, (yByRow.get(yKey) ?? 0) + 1);
  }
  const counts = Array.from(yByRow.values());
  return {
    rows: counts.length,
    maxColsPerRow: Math.max(...counts),
    total: count,
  };
}

test.describe('chain chooser grid 列数 (viewport 連動)', () => {
  test('QR generator: USDC 6 chain が viewport に応じた列数で並ぶ', async ({
    page,
    viewport,
  }) => {
    await page.goto('/ja');

    // USDC tab を選択 (default は JPYC)
    await page.getByRole('button', { name: 'USDC' }).click();

    // chain chooser が出るまで待機 (USDC は 6 chain あるので Base/Arbitrum 等)
    await expect(
      page.getByRole('button', { name: /^Base/ }).first(),
    ).toBeVisible();

    const chainButtons = page.locator(
      'div.grid.grid-cols-2:has(button[type="button"] img[src*="/chains/"]) > button',
    );

    await expect(chainButtons).toHaveCount(6);

    const { rows, maxColsPerRow, total } = await getRowsAndCols(chainButtons);
    expect(total).toBe(6);

    // < 640px: grid-cols-2 / >= 640px: sm:grid-cols-3
    const expectedCols = viewport!.width < 640 ? 2 : 3;
    expect(maxColsPerRow).toBe(expectedCols);
    expect(rows).toBe(Math.ceil(6 / expectedCols));
  });

  // CheckoutLinkGenerator は production route に未 mount のため e2e からは除外
  // (ChainChooser.test.tsx で structural 検証済)。

  test('Tip widget generator: USDC chain chooser も同じ列数', async ({
    page,
    viewport,
  }) => {
    await page.goto('/ja');
    await page
      .getByRole('button', { name: 'Tip widget (クリエイター)' })
      .click();

    // USDC tab に切替 (Tip default は JPYC)
    await page.getByRole('button', { name: 'USDC' }).click();

    await expect(
      page.getByRole('button', { name: /^Base/ }).first(),
    ).toBeVisible();

    const chainButtons = page.locator(
      'div.grid.grid-cols-2:has(button[type="button"] img[src*="/chains/"]) > button',
    );
    await expect(chainButtons).toHaveCount(6);

    const { maxColsPerRow } = await getRowsAndCols(chainButtons);
    const expectedCols = viewport!.width < 640 ? 2 : 3;
    expect(maxColsPerRow).toBe(expectedCols);
  });
});
