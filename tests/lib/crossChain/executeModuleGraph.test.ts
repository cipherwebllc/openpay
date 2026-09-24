import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as facade from '@/lib/crossChain/execute';
import * as errors from '@/lib/crossChain/executeErrors';
import * as shared from '@/lib/crossChain/executeShared';
import * as gateway from '@/lib/crossChain/executeGateway';
import * as cctpExecutor from '@/lib/crossChain/executeCctp';
import * as forward from '@/lib/crossChain/executeForward';
import { assertBurnResolved } from '@/lib/crossChain/burnRecovery';

// R12 で lib/crossChain/execute.ts を protocol 別 module に分けた構造のガード。挙動の固定は
// executeFacadePins.test.ts (分割前のコードでも通ることを確認済み) が持つ。ここは分割後にしか
// 書けない性質だけを見る:
//   - facade の export が分割先の leaf と同じ object (error class を 2 回定義していない)
//   - 分割先同士の runtime import に循環が無い (特に cctp → forward → cctp)・facade を経由しない
//   - 実行ごとの state を module 単位に持たない (top-level の let/var・新しい const を足さない)
//   - deploycheck の cache を複製せず、各 executor が 1 つの module を import する

const DIR = join(__dirname, '../../../lib/crossChain');
const SPLIT = ['execute', 'executeTypes', 'executeErrors', 'executeShared', 'burnRecovery',
  'executeGateway', 'executeCctp', 'executeForward'] as const;

function parse(name: string): ts.SourceFile {
  return ts.createSourceFile(`${name}.ts`, readFileSync(join(DIR, `${name}.ts`), 'utf8'), ts.ScriptTarget.Latest, true);
}

/** 型だけの import / re-export を除いた runtime の依存先 (相対 path はそのまま)。 */
function runtimeImports(file: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const stmt of file.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (clause?.isTypeOnly) continue;
      const named = clause?.namedBindings;
      const onlyTypes = !clause?.name && named && ts.isNamedImports(named) && named.elements.every((e) => e.isTypeOnly);
      if (!onlyTypes) out.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      if (stmt.isTypeOnly) continue;
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause) && clause.elements.every((e) => e.isTypeOnly)) continue;
      out.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return out;
}

describe('R12: execute.ts split structure', () => {
  it('facade re-exports the single definitions from the leaves', () => {
    expect(facade.CrossChainBurnUnresolvedError).toBe(errors.CrossChainBurnUnresolvedError);
    expect(facade.CrossChainQuoteExpiredError).toBe(errors.CrossChainQuoteExpiredError);
    expect(facade.CrossChainForwardPendingError).toBe(errors.CrossChainForwardPendingError);
    expect(facade.ensureWalletChain).toBe(shared.ensureWalletChain);
    expect(facade.executeGatewayTransfer).toBe(gateway.executeGatewayTransfer);
    expect(facade.assertGatewayTransferEnabled).toBe(gateway.assertGatewayTransferEnabled);
    expect(facade.executeCctpTransfer).toBe(cctpExecutor.executeCctpTransfer);
    expect(facade.assertForwardQuoteBinding).toBe(forward.assertForwardQuoteBinding);
  });

  it('shared burn recovery throws the facade error class', () => {
    const progress: string[] = [];
    let thrown: unknown;
    try {
      assertBurnResolved({ action: 'wait', row: 5, reason: 'pending tx in mempool' },
        { slot: 'fee', sourceChainId: 84532, depositor: '0x7a1c3e5f9b2d4c6a8e0f1b3d5c7e9a2b4d6f8a0c' },
        (p) => progress.push(p.kind));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(facade.CrossChainBurnUnresolvedError);
    expect(progress).toEqual(['burn_unconfirmed']);
  });

  it('error classes are declared exactly once across the split modules', () => {
    const declared = SPLIT.flatMap((name) => parse(name).statements
      .filter(ts.isClassDeclaration).map((c) => `${name}:${c.name?.text}`));
    expect(declared.sort()).toEqual([
      'executeErrors:CrossChainBurnUnresolvedError',
      'executeErrors:CrossChainForwardPendingError',
      'executeErrors:CrossChainQuoteExpiredError',
    ]);
  });

  it('has no runtime import cycle and never routes through the facade', () => {
    const graph = new Map<string, string[]>(SPLIT.map((name) => [name,
      runtimeImports(parse(name)).filter((s) => s.startsWith('./')).map((s) => s.slice(2))
        .filter((s) => (SPLIT as readonly string[]).includes(s))]));
    // 型 leaf は runtime の依存を一切持たない。error leaf も型しか参照しない。
    expect(runtimeImports(parse('executeTypes'))).toEqual([]);
    expect(runtimeImports(parse('executeErrors'))).toEqual([]);
    for (const [name, deps] of graph) if (name !== 'execute') expect(deps, name).not.toContain('execute');
    expect(graph.get('executeForward')).not.toContain('executeCctp');
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (node: string, path: string[]): void => {
      if (done.has(node)) return;
      expect(visiting.has(node), `cycle: ${[...path, node].join(' -> ')}`).toBe(false);
      visiting.add(node);
      for (const next of graph.get(node) ?? []) visit(next, [...path, node]);
      visiting.delete(node);
      done.add(node);
    };
    for (const name of SPLIT) visit(name, []);
  });

  it('keeps per-execution state local (no new module-level variables)', () => {
    const topLevel = SPLIT.flatMap((name) => parse(name).statements.filter(ts.isVariableStatement).flatMap((stmt) => {
      const kind = stmt.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let/var';
      return stmt.declarationList.declarations.map((d) => `${name}:${kind}:${d.name.getText()}`);
    }));
    // 分割前から在る不変の定数だけ (chain 切替の poll 設定・fee 宛先の焼失 address 集合)。
    expect(topLevel.sort()).toEqual([
      'executeShared:const:CHAIN_SWITCH_CONFIRM_ATTEMPTS',
      'executeShared:const:CHAIN_SWITCH_CONFIRM_INTERVAL_MS',
      'executeShared:const:FEE_RECEIVER_BURN_ADDRESSES',
    ]);
  });

  it('every executor uses the single deploycheck module (one verified/inflight cache)', () => {
    for (const name of ['executeGateway', 'executeCctp', 'executeForward']) {
      expect(runtimeImports(parse(name)), name).toContain('./deploycheck');
    }
    const source = SPLIT.map((name) => readFileSync(join(DIR, `${name}.ts`), 'utf8')).join('\n');
    expect(source).not.toMatch(/\b(?:verified|inflight)\s*=\s*new Map/);
  });

  // 分割で export された内部関数 (executeForwardTransfer・burn 回復・共有 helper) を外から直接 import すると、
  // executeCctpTransfer の入口の検査 (forward 専用の宛先・domain 26・source domain・fee=0) を飛ばせる。
  // lib/crossChain の外は facade (execute.ts) だけを import する (レビュー S1)。
  it('nothing outside lib/crossChain imports the split leaves directly', () => {
    const ROOT = join(__dirname, '../../..');
    const LEAVES = SPLIT.filter((name) => name !== 'execute');
    const pattern = new RegExp(`['"](?:@/lib/crossChain|(?:\\.\\./)+lib/crossChain|\\./crossChain)/(?:${LEAVES.join('|')})['"]`);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry === 'node_modules' || entry === '.next') continue;
        if (statSync(full).isDirectory()) { if (full !== DIR) walk(full); continue; }
        if (!/\.(?:ts|tsx|mts)$/.test(entry)) continue;
        if (full === join(__dirname, 'executeModuleGraph.test.ts')) continue;
        if (pattern.test(readFileSync(full, 'utf8'))) offenders.push(full.slice(ROOT.length + 1));
      }
    };
    for (const top of ['app', 'components', 'hooks', 'lib', 'tests']) walk(join(ROOT, top));
    expect(offenders).toEqual([]);
  });
});
