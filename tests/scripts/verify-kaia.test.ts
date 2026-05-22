// scripts/verify-kaia-jpyc.mjs と scripts/verify-kaia-pimlico.mjs の structural
// fence。実 RPC / Pimlico API は CI ではアクセスしない (DEPLOY_CHECKLIST §7 の
// 手動 SOP として位置付け) ので、本テストはスクリプトが「import 可能」かつ
// 「syntax error なし」かつ「必須引数欠落時に exit code 2 (= usage error) で
// 落ちる」までを検証する。
//
// 本質的な検証 (実 Kaia bytecode / Pimlico bundler 応答) は手動実行で行う。
// 該当 script の出力例は scripts/verify-kaia-{jpyc,pimlico}.mjs 冒頭 comment 参照。

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const JPYC_SCRIPT = resolve('./scripts/verify-kaia-jpyc.mjs');
const PIMLICO_SCRIPT = resolve('./scripts/verify-kaia-pimlico.mjs');

describe('scripts/verify-kaia-jpyc.mjs', () => {
  it('file exists', () => {
    expect(existsSync(JPYC_SCRIPT)).toBe(true);
  });

  it('syntactically valid (node --check)', () => {
    const r = spawnSync('node', ['--check', JPYC_SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('required env / arg 欠落で exit code 2 + 使い方メッセージ', () => {
    // address / RPC 未指定で起動 → process.exit(2)
    const r = spawnSync('node', [JPYC_SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NEXT_PUBLIC_JPYC_KAIA_ADDRESS: '',
        NEXT_PUBLIC_JPYC_KAIROS_ADDRESS: '',
      },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/address が未設定/);
  });

  it('未知 CLI flag は exit code 2', () => {
    const r = spawnSync('node', [JPYC_SCRIPT, '--bogus'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown arg/);
  });

  it('script 内で JPYC v3 既知 address (cross-chain consistency baseline) を保持', () => {
    // memory:reference_jpyc_contract と整合性チェック。文字列変更で memory との
    // drift 防止 (sed 等で誤 commit された場合に CI で落とす)。
    const src = readFileSync(JPYC_SCRIPT, 'utf8');
    expect(src).toContain('0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29');
  });

  it('JPYC v3 metadata 期待値が hard-code されている (name / symbol / decimals)', () => {
    const src = readFileSync(JPYC_SCRIPT, 'utf8');
    expect(src).toContain("name === 'JPY Coin'");
    expect(src).toContain("symbol === 'JPYC'");
    expect(src).toMatch(/decimals\s*===\s*18/);
  });

  it('EIP-2612 permit 必須インタフェース 3 項目を verify する', () => {
    const src = readFileSync(JPYC_SCRIPT, 'utf8');
    expect(src).toContain('DOMAIN_SEPARATOR');
    expect(src).toContain('nonces');
    expect(src).toContain('permit');
  });
});

describe('scripts/verify-kaia-pimlico.mjs', () => {
  it('file exists', () => {
    expect(existsSync(PIMLICO_SCRIPT)).toBe(true);
  });

  it('syntactically valid (node --check)', () => {
    const r = spawnSync('node', ['--check', PIMLICO_SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('NEXT_PUBLIC_PIMLICO_API_KEY 欠落で exit code 2', () => {
    const env = { ...process.env };
    delete env.NEXT_PUBLIC_PIMLICO_API_KEY;
    // .env.local の自動 load で key が入ってしまわないよう、empty cwd の tmp で実行
    // (現在の cwd の .env.local をロードしないようにディレクトリを変える)
    const r = spawnSync('node', [PIMLICO_SCRIPT], {
      encoding: 'utf8',
      env: { ...env, NEXT_PUBLIC_PIMLICO_API_KEY: '' },
      cwd: '/tmp',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/NEXT_PUBLIC_PIMLICO_API_KEY/);
  });

  it('--mainnet-only と --testnet-only の同時指定は exit code 2', () => {
    const r = spawnSync(
      'node',
      [PIMLICO_SCRIPT, '--mainnet-only', '--testnet-only'],
      {
        encoding: 'utf8',
        env: { ...process.env, NEXT_PUBLIC_PIMLICO_API_KEY: 'pim_test_dummy' },
      },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/同時指定不可/);
  });

  it('EntryPoint v0.7 canonical address を hard-code', () => {
    // eth-infinitism の deterministic deploy address。drift 検知 (誤 commit 防止)。
    const src = readFileSync(PIMLICO_SCRIPT, 'utf8');
    expect(src).toContain('0x0000000071727De22E5E9d8BAf0edAc6f37da032');
  });

  it('3 つの gas price tier (slow / standard / fast) を検証する', () => {
    const src = readFileSync(PIMLICO_SCRIPT, 'utf8');
    expect(src).toMatch(/'slow',\s*'standard',\s*'fast'/);
  });

  it('Kaia mainnet (8217) + Kairos testnet (1001) 両方を default で検証', () => {
    const src = readFileSync(PIMLICO_SCRIPT, 'utf8');
    expect(src).toContain('kaia');
    expect(src).toContain('kairos');
  });
});
