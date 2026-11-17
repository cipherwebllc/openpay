import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// 会計ごとの印 (bill key・URL の `bk`) に触れる file を、名前で数えて固定する柵。
// 払う側で bill key を使うのは「/pay と /checkout の JPYC ガスレス (forwarder のある経路・束縛なし)」だけ。チップ・
// お店の端末で送る・USDC・通常決済・クロスチェーン・URL の parser と builder・履歴・控え・記録の送信・復旧の枠・server は
// bill key を知らない。
// お店の側で bill key を作って載せるのは「/create の決済QR・レジが、画面に表示中の通常の QR」だけ (hooks/useQrBillKey.ts)。
// 注文リンク・モバイルオーダー・お店の端末で送る の URL を作る所・URL のコピー・QR の保存・前回の受け取り QR は bill key を
// 知らない。入金を確かめる code (lib/qrSaleWatch.ts・lib/qrSaleHistory.ts) は遅延 chunk だけに置く。
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

  it('bill key という名前に触れるのは 14 の file だけ (払う側 5 つ・お店の側 9 つ)', () => {
    expect(matching(/bill[-_ ]?key/i)).toEqual([
      // お店の側: /create のページ (見張りを止める所)。
      'app/[locale]/create/page.tsx',
      'components/CheckoutForm.tsx',
      'components/PaymentForm.tsx',
      // お店の側: QR を出す 2 つの画面 (QrGenerator・RegisterMode) と、QR の画面の部品 2 つ。
      'components/QrGenerator.tsx',
      'components/QrPreviewModal.tsx',
      'components/RegisterMode.tsx',
      'components/qr-generator/PaymentQrModal.tsx',
      'hooks/useJpycEip3009Payment.ts',
      // お店の側: bill key を作って画面の QR に載せる hook・入金を確かめる code (遅延 chunk)。
      'hooks/useQrBillKey.ts',
      'lib/qrSaleHistory.ts',
      'lib/qrSaleWatch.ts',
      'lib/relay/billKeySalt.ts',
      'lib/url/billKey.ts',
      // お店の側: bill key を作る・画面の QR の URL に足す関数。
      'lib/url/billKeyQr.ts',
    ]);
  });

  it('URL から bk を読む関数を呼ぶのは /pay と /checkout のフォームだけ', () => {
    expect(matching(/readBillKeyParam/)).toEqual([
      'components/CheckoutForm.tsx',
      'components/PaymentForm.tsx',
      'lib/url/billKey.ts',
    ]);
  });

  it('bill key の salt の module を読むのは、JPYC ガスレスの hook (遅延 import の 1 か所) と、入金を確かめる code だけ', () => {
    expect(matching(/relay\/billKeySalt['"]/)).toEqual(['hooks/useJpycEip3009Payment.ts', 'lib/qrSaleHistory.ts']);
    const hook = files.find(({ file }) => file === 'hooks/useJpycEip3009Payment.ts')!.source;
    expect(hook.match(/billKeySalt['"]/g)).toHaveLength(1);
    expect(hook).toContain("await import('@/lib/relay/billKeySalt')");
    // First Load JS に載せない: 静的な import にしない。
    expect(hook).not.toMatch(/^import .*billKeySalt/m);
  });

  it('URL の param の名前 bk を知っているのは、読む lib/url/billKey.ts と、画面の QR に足す lib/url/billKeyQr.ts だけ (parser・builder は知らない)', () => {
    // 文字列の 'bk' / "bk" と、URL の中の ?bk= / &bk= を探す (注記の中の `bk` は数えない)。
    expect(matching(/['"]bk['"]|[?&]bk=/)).toEqual(['lib/url/billKey.ts', 'lib/url/billKeyQr.ts']);
  });

  it('bill key を作る・URL に足す関数を呼ぶのは hooks/useQrBillKey.ts だけ・その hook を使うのは決済QR とレジだけ', () => {
    expect(matching(/\b(newBillKey|withBillKey)\b/)).toEqual(['hooks/useQrBillKey.ts', 'lib/url/billKeyQr.ts']);
    // 呼び出しの形 (注記の中の file 名は数えない)。
    expect(matching(/\buseQrBillKey\(/)).toEqual([
      'components/QrGenerator.tsx',
      'components/RegisterMode.tsx',
      'hooks/useQrBillKey.ts',
    ]);
    // ページを離れたら見張りを止める所は、/create のページだけ。
    expect(matching(/\buseQrSaleWatchScope\b/)).toEqual(['app/[locale]/create/page.tsx', 'hooks/useQrBillKey.ts']);
  });

  it('入金を確かめる code は遅延 chunk だけ: 見張りは hooks/useQrBillKey.ts の dynamic import からしか読まれない', () => {
    // 見張り (lib/qrSaleWatch) を読むのは hook だけで、静的な import は型だけ (/create の First Load JS に載せない)。
    expect(matching(/['"](@\/lib|\.)\/qrSaleWatch['"]/)).toEqual(['hooks/useQrBillKey.ts']);
    const hook = files.find(({ file }) => file === 'hooks/useQrBillKey.ts')!.source;
    expect(hook).toContain("import('@/lib/qrSaleWatch')");
    expect(hook).not.toMatch(/^import .*qrSaleWatch/m);
    // 一致の判定と行の組み立て・RPC の読み取りは、見張りからしか読まれない。
    expect(matching(/['"](@\/lib|\.)\/qrSaleHistory['"]/)).toEqual(['lib/qrSaleWatch.ts']);
    expect(matching(/['"](@\/lib|\.)\/qrSaleRpc['"]/)).toEqual(['lib/qrSaleWatch.ts']);
  });

  it('お店の側の bill key は保存しない: 作る・載せる・確かめる file は localStorage / sessionStorage に触れない', () => {
    for (const name of ['hooks/useQrBillKey.ts', 'lib/url/billKeyQr.ts', 'lib/qrSaleHistory.ts', 'lib/qrSaleWatch.ts']) {
      // 注記の中の言葉は数えない (code が storage を呼ぶ形だけを探す)。
      expect(files.find(({ file }) => file === name)!.source).not.toMatch(/(local|session)Storage\s*\.\s*\w+\(/);
    }
    // 見張りが storage に書くのは、履歴の行 (appendHistory) と tx の印 (lib/qrSaleMarks.ts) だけ。印の module は bill key を知らない。
    expect(files.find(({ file }) => file === 'lib/qrSaleMarks.ts')!.source).not.toMatch(/bill/i);
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
