import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accessStatusForPhase,
  contentReadBackFrom,
  isRecord,
  paymentStatusForPhase,
  purchaseStatusFrom,
  responseJson,
} from '@/lib/x402/hostedPurchasePhases';
import {
  CONTENT_READBACK_CASES,
  PHASE_STATUS_TABLE,
  PURCHASE_STATUS_CASES,
  TABLE_INTENT_SALT,
  TABLE_RESOURCE_ID,
} from '../../_helpers/hostedPurchaseResponseTables';

// 同じテーブルを tests/hooks/useHostedStorePurchase.pins.test.tsx が hook 経由でも検査する
// (抽出前のコードでも走らせて同一挙動を確認済み)。ここでは戻り値そのものを厳密に固定する。

describe('purchaseStatusFrom', () => {
  it.each(PURCHASE_STATUS_CASES)('$label', ({ body, expected }) => {
    if (expected === null) {
      expect(() => purchaseStatusFrom(body)).toThrow(
        new Error('purchase_status_invalid'),
      );
      return;
    }
    expect(purchaseStatusFrom(body)).toStrictEqual(expected);
  });
});

describe('contentReadBackFrom', () => {
  it.each(CONTENT_READBACK_CASES)('$label', ({ body, expected }) => {
    if (expected === null) {
      expect(() =>
        contentReadBackFrom(body, TABLE_RESOURCE_ID, TABLE_INTENT_SALT),
      ).toThrow(new Error('store_content_invalid'));
      return;
    }
    expect(
      contentReadBackFrom(body, TABLE_RESOURCE_ID, TABLE_INTENT_SALT),
    ).toStrictEqual(expected);
  });
});

describe('paymentStatusForPhase / accessStatusForPhase', () => {
  it.each(PHASE_STATUS_TABLE)(
    '%s → payment=%s / access=%s',
    (phase, paymentStatus, accessStatus) => {
      expect(paymentStatusForPhase(phase)).toBe(paymentStatus);
      expect(accessStatusForPhase(phase)).toBe(accessStatus);
    },
  );
});

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{ ok: true }, true],
    [Object.create(null), true],
    [null, false],
    [[], false],
    ['x', false],
    [1, false],
    [undefined, false],
  ])('%j → %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('responseJson', () => {
  it('JSON body を parse する', async () => {
    await expect(
      responseJson(new Response('{"ok":true,"state":"pending"}')),
    ).resolves.toStrictEqual({ ok: true, state: 'pending' });
  });

  it.each([
    ['非 JSON', '<html>proxy error</html>'],
    ['空 body', ''],
  ])('%s は throw せず null', async (_label, text) => {
    await expect(responseJson(new Response(text))).resolves.toBeNull();
  });

  it('JSON の null literal も null (呼び出し側は非 JSON と区別しない)', async () => {
    await expect(responseJson(new Response('null'))).resolves.toBeNull();
  });
});

describe('module 境界', () => {
  it('React / wagmi / env / server 専用 module に依存しない (browser-safe の純粋 module)', () => {
    const source = readFileSync(
      join(process.cwd(), 'lib/x402/hostedPurchasePhases.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import .*$/gm)].map((m) => m[0]);
    expect(imports).toEqual(["import type { Hex } from 'viem';"]);
    expect(source).not.toMatch(/^'use client'/m);
  });
});
