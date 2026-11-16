import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 会計ごとの印 (bill key・URL の `bk`) に触れる file を、名前で数えて固定する柵。
// bill key を使うのは「/pay と /checkout の JPYC ガスレス (forwarder のある経路・束縛なし)」だけ。チップ・お店の端末で送る・
// USDC・通常決済・クロスチェーン・URL の parser と builder・履歴・控え・記録の送信・復旧の枠・server は bill key を知らない。
// 一覧の外の file が bill key に触れたら落ちる (使う場所を足すときは、その経路の柵のテストと一緒に一覧を直す)。
const ROOT = process.cwd();
const SOURCE_DIRS = ['app', 'components', 'hooks', 'lib'];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(path);
  }
  return out;
}

const files = SOURCE_DIRS.flatMap((dir) => sourceFiles(join(ROOT, dir))).map((path) => ({
  file: relative(ROOT, path),
  source: readFileSync(path, 'utf8'),
}));
const matching = (pattern: RegExp) => files.filter(({ source }) => pattern.test(source)).map(({ file }) => file).sort();

describe('bill key に触れる file の柵', () => {
  it('走査が source を見ている (数百の file・決済の hook を含む)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.map(({ file }) => file)).toContain('hooks/useStoreDevicePayment.ts');
    expect(files.map(({ file }) => file)).toContain('components/TipForm.tsx');
  });

  it('bill key という名前に触れるのは 5 つの file だけ', () => {
    expect(matching(/bill[-_ ]?key/i)).toEqual([
      'components/CheckoutForm.tsx',
      'components/PaymentForm.tsx',
      'hooks/useJpycEip3009Payment.ts',
      'lib/relay/billKeySalt.ts',
      'lib/url/billKey.ts',
    ]);
  });

  it('URL から bk を読む関数を呼ぶのは /pay と /checkout のフォームだけ', () => {
    expect(matching(/readBillKeyParam/)).toEqual([
      'components/CheckoutForm.tsx',
      'components/PaymentForm.tsx',
      'lib/url/billKey.ts',
    ]);
  });

  it('bill key の salt の module を読むのは JPYC ガスレスの hook だけ (遅延 import の 1 か所)', () => {
    expect(matching(/relay\/billKeySalt['"]/)).toEqual(['hooks/useJpycEip3009Payment.ts']);
    const hook = files.find(({ file }) => file === 'hooks/useJpycEip3009Payment.ts')!.source;
    expect(hook.match(/billKeySalt['"]/g)).toHaveLength(1);
    expect(hook).toContain("await import('@/lib/relay/billKeySalt')");
    // First Load JS に載せない: 静的な import にしない。
    expect(hook).not.toMatch(/^import .*billKeySalt/m);
  });

  it('URL の param の名前 bk を知っているのは lib/url/billKey.ts だけ (parser・builder・QR を作る側は知らない)', () => {
    // 文字列の 'bk' / "bk" と、URL の中の ?bk= / &bk= を探す (注記の中の `bk` は数えない)。
    expect(matching(/['"]bk['"]|[?&]bk=/)).toEqual(['lib/url/billKey.ts']);
  });

  it('JPYC ガスレスの hook の free の経路 (forwarder なし) の code は bill key に触れない', () => {
    const hook = files.find(({ file }) => file === 'hooks/useJpycEip3009Payment.ts')!.source;
    const start = hook.indexOf('// free: 直接 transferWithAuthorization');
    const end = hook.indexOf('// Only a resolved signature can leave a restorable order');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const freeBranch = hook.slice(start, end);
    expect(freeBranch).toContain('nonce: boundSalt ?? randomAuthorizationNonce()');
    expect(freeBranch).not.toMatch(/bill/i);
  });
});
