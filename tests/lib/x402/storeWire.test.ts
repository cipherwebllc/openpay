import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  hostedResourceUrl,
  isHostedLabel,
  isRecord,
  isSafeTimestamp,
  parseAddress,
  parseHex32,
} from '@/lib/x402/storeWire';

describe('store wire leaf boundaries', () => {
  it('keeps the old public exports identical to the extracted definitions', async () => {
    const store = await import('@/lib/x402/hostedStore');
    const legal = await import('@/lib/legal');
    const fee = await import('@/lib/disclosedX402Fee');
    expect(store.isHostedLabel).toBe(isHostedLabel);
    expect(legal.DISCLOSED_X402_FEE).toBe(fee.DISCLOSED_X402_FEE);
  });

  it.each([
    ['lib/x402/storeWire.ts', ['viem']],
    ['lib/disclosedX402Fee.ts', []],
  ] as const)('%s has only browser-safe runtime dependencies', (path, allowed) => {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    function visit(node: ts.Node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly;
        if (!typeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          imports.push(node.moduleSpecifier.text);
        }
      }
      if (ts.isCallExpression(node) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === 'require'
      )) throw new Error('Leaf runtime dependencies must be static');
      ts.forEachChild(node, visit);
    }
    visit(source);
    expect(imports).toEqual(allowed);
  });

  it('does not encode, normalize or reorder the literal resource/payer input', () => {
    expect(hostedResourceUrl('h_raw%2Fvalue', '0xAbC', 'jpyc')).toBe(
      'https://open-pay.jp/api/paid/hosted/h_raw%2Fvalue?payer=0xAbC',
    );
    expect(hostedResourceUrl('h_raw%2Fvalue', '0xAbC', 'usdc')).toBe(
      'https://open-pay.jp/api/paid/hosted/h_raw%2Fvalue?payer=0xAbC&rail=usdc',
    );
  });
});

// 両 rail が保存済み intent を読み戻すときの共通 validator (レビュー S1: 既存テストでは壊しても落ちなかった)。
describe('shared stored-intent validators', () => {
  const checksummed = '0x52908400098527886E0F7030069857D2E4169EE7';

  it.each([
    [{}, true], [{ a: 1 }, true], [[], false], [null, false], ['x', false], [1, false],
  ])('isRecord(%j) = %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });

  it.each([
    [0, true], [1_700_000_000, true], [Number.MAX_SAFE_INTEGER, true],
    [-1, false], [1.5, false], [Number.MAX_SAFE_INTEGER + 1, false], ['1', false], [Number.NaN, false],
  ])('isSafeTimestamp(%s) = %s', (value, expected) => {
    expect(isSafeTimestamp(value)).toBe(expected);
  });

  it('parseAddress checksums valid addresses and rejects the rest', () => {
    expect(parseAddress(checksummed.toLowerCase())).toBe(checksummed);
    expect(parseAddress(checksummed)).toBe(checksummed);
    // 大小文字が混在して checksum が合わないものは拒否する。
    expect(parseAddress('0x52908400098527886E0F7030069857D2E4169Ee7')).toBeNull();
    expect(parseAddress('0x1234')).toBeNull();
    expect(parseAddress(123)).toBeNull();
  });

  it('parseHex32 lowercases 32-byte hex and rejects other lengths/types', () => {
    const upper = `0x${'AB'.repeat(32)}`;
    expect(parseHex32(upper)).toBe(`0x${'ab'.repeat(32)}`);
    expect(parseHex32(`0x${'ab'.repeat(31)}`)).toBeNull();
    expect(parseHex32(`${'ab'.repeat(32)}`)).toBeNull();
    expect(parseHex32(`0x${'zz'.repeat(32)}`)).toBeNull();
    expect(parseHex32(null)).toBeNull();
  });
});
