import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseOwnOrderNotifyUrl, type OwnOrderNotifyUrl } from '@/lib/order/ownNotifyUrl';
import { parseSource, readSource } from '../_helpers/runtimeImports';

// lib/order/ownNotifyUrl.ts の parseOwnOrderNotifyUrl (第 10 回レビュー PR-14)。
// ここは解析だけの表。使う所ごとの方針 (h の数・正規化・お店の @handle との照合・読めない URL の扱い) がどう効くかは、
// tests/components/CheckoutForm.orderNotify.characterization.test.tsx の「自社 URL の判定の表」(URL_ROWS) が画面ごとに固定している。

// vitest.config.ts の jsdom の url と同じ (characterization の ORIGIN と同じ値)。
const ORIGIN = 'https://test.local';
const own = (...handles: string[]): OwnOrderNotifyUrl => ({ kind: 'own', handles });
const OTHER: OwnOrderNotifyUrl = { kind: 'other' };
const UNREADABLE: OwnOrderNotifyUrl = { kind: 'unreadable' };

type Row = { name: string; webhook: string; origin?: string; want: OwnOrderNotifyUrl };

// characterization の URL_ROWS と同じ形 (18 行のうち「webhook なし」は、どの呼び出し側も parser を呼ぶ前に外すので、ここには無い)。
const URL_ROWS_SHAPES: Row[] = [
  { name: 'h が 1 つ', webhook: `${ORIGIN}/api/order/notify?h=alice`, want: own('alice') },
  { name: 'h が 1 つ + ほかの query', webhook: `${ORIGIN}/api/order/notify?h=alice&utm=x`, want: own('alice') },
  { name: 'h が大文字 (小文字にしない)', webhook: `${ORIGIN}/api/order/notify?h=ALICE`, want: own('ALICE') },
  { name: 'h に @ つき (percent-encoding は解くが、@ は外さない)', webhook: `${ORIGIN}/api/order/notify?h=%40alice`, want: own('@alice') },
  { name: 'h が別のお店', webhook: `${ORIGIN}/api/order/notify?h=bob`, want: own('bob') },
  { name: 'h なし', webhook: `${ORIGIN}/api/order/notify`, want: own() },
  { name: 'h が空 (空の文字列が 1 つ)', webhook: `${ORIGIN}/api/order/notify?h=`, want: own('') },
  { name: 'h が 2 つ (並びのまま)', webhook: `${ORIGIN}/api/order/notify?h=alice&h=bob`, want: own('alice', 'bob') },
  { name: 'h が 2 つ (同じ値・まとめない)', webhook: `${ORIGIN}/api/order/notify?h=alice&h=alice`, want: own('alice', 'alice') },
  { name: '同じ origin・path の末尾に /', webhook: `${ORIGIN}/api/order/notify/?h=alice`, want: OTHER },
  { name: '同じ origin・別の path', webhook: `${ORIGIN}/api/order/status?h=alice`, want: OTHER },
  { name: '別の origin・同じ path', webhook: 'https://shop.example/api/order/notify?h=alice', want: OTHER },
  { name: '別の origin・query に path を仕込む', webhook: 'https://shop.example/hook?next=/api/order/notify&h=alice', want: OTHER },
  { name: '同じ host・別の scheme', webhook: 'http://test.local/api/order/notify?h=alice', want: OTHER },
  { name: '同じ host・別の port', webhook: 'https://test.local:8443/api/order/notify?h=alice', want: OTHER },
  { name: '相対 URL', webhook: '/api/order/notify?h=alice', want: UNREADABLE },
  { name: 'URL として読めない', webhook: 'not a url', want: UNREADABLE },
];

// h の値は URLSearchParams が解いたまま (trim・小文字化・@ 外しは呼び出し側の方針)。
const HANDLE_ROWS: Row[] = [
  { name: 'h の前後に空白 (%20)', webhook: `${ORIGIN}/api/order/notify?h=%20alice%20`, want: own(' alice ') },
  { name: 'h の + は空白になる', webhook: `${ORIGIN}/api/order/notify?h=+alice`, want: own(' alice') },
  { name: 'h に percent-encoding した日本語', webhook: `${ORIGIN}/api/order/notify?h=%E3%81%82`, want: own('あ') },
  { name: 'h に percent-encoding した &', webhook: `${ORIGIN}/api/order/notify?h=a%26h%3Db`, want: own('a&h=b') },
  { name: 'key が大文字の H は h ではない', webhook: `${ORIGIN}/api/order/notify?H=alice`, want: own() },
  { name: 'key が h と H の両方', webhook: `${ORIGIN}/api/order/notify?h=alice&H=bob`, want: own('alice') },
  { name: 'ほかの query の後ろの h', webhook: `${ORIGIN}/api/order/notify?utm=x&h=alice`, want: own('alice') },
  { name: 'h に値が無い (= なし)', webhook: `${ORIGIN}/api/order/notify?h`, want: own('') },
  { name: 'fragment は h に入らない', webhook: `${ORIGIN}/api/order/notify?h=alice#frag`, want: own('alice') },
  { name: 'fragment の中の h は見ない', webhook: `${ORIGIN}/api/order/notify#?h=alice`, want: own() },
];

// origin は url.origin と文字列の完全一致で比べる。pathname も完全一致。URL の正規化 (new URL がすること) の後の値を見る。
const ORIGIN_AND_PATH_ROWS: Row[] = [
  { name: 'origin の引数の末尾に / があると合わない', webhook: `${ORIGIN}/api/order/notify?h=alice`, origin: `${ORIGIN}/`, want: OTHER },
  { name: 'origin の引数が大文字だと合わない', webhook: `${ORIGIN}/api/order/notify?h=alice`, origin: 'https://TEST.local', want: OTHER },
  { name: 'origin の引数が空だと合わない', webhook: `${ORIGIN}/api/order/notify?h=alice`, origin: '', want: OTHER },
  { name: 'origin の引数が host だけだと合わない', webhook: `${ORIGIN}/api/order/notify?h=alice`, origin: 'test.local', want: OTHER },
  { name: 'URL の scheme と host の大文字は new URL が小文字にする', webhook: 'HTTPS://TEST.LOCAL/api/order/notify?h=alice', want: own('alice') },
  { name: 'URL の既定の port (:443) は new URL が落とす', webhook: 'https://test.local:443/api/order/notify?h=alice', want: own('alice') },
  { name: 'userinfo つきの URL は origin に入らないので自社になる', webhook: 'https://user:pass@test.local/api/order/notify?h=alice', want: own('alice') },
  { name: 'host の前に自社の host を userinfo として置いても別の origin', webhook: 'https://test.local@shop.example/api/order/notify?h=alice', want: OTHER },
  { name: 'host が自社の subdomain', webhook: 'https://a.test.local/api/order/notify?h=alice', want: OTHER },
  { name: 'host の末尾に . がつく', webhook: 'https://test.local./api/order/notify?h=alice', want: OTHER },
  { name: 'pathname の大文字', webhook: `${ORIGIN}/API/order/notify?h=alice`, want: OTHER },
  { name: 'pathname の前に別の segment', webhook: `${ORIGIN}/ja/api/order/notify?h=alice`, want: OTHER },
  { name: 'pathname の後ろに別の segment', webhook: `${ORIGIN}/api/order/notify/extra?h=alice`, want: OTHER },
  { name: 'pathname の / が 2 つ', webhook: `${ORIGIN}/api//order/notify?h=alice`, want: OTHER },
  { name: 'pathname の percent-encoding は解かれない', webhook: `${ORIGIN}/api/order/%6Eotify?h=alice`, want: OTHER },
  { name: 'pathname の .. は new URL がたたむ', webhook: `${ORIGIN}/api/order/x/../notify?h=alice`, want: own('alice') },
  { name: 'pathname の \\ は new URL が / にする', webhook: `${ORIGIN}\\api\\order\\notify?h=alice`, want: own('alice') },
  { name: 'URL の前後の空白は new URL が落とす', webhook: ` ${ORIGIN}/api/order/notify?h=alice `, want: own('alice') },
  { name: 'scheme が無い (host から始まる)', webhook: 'test.local/api/order/notify?h=alice', want: UNREADABLE },
  { name: 'scheme-relative (// から始まる)', webhook: '//test.local/api/order/notify?h=alice', want: UNREADABLE },
  { name: '空の文字列', webhook: '', want: UNREADABLE },
  { name: 'javascript: の URL', webhook: 'javascript:alert(1)', want: OTHER },
];

describe('parseOwnOrderNotifyUrl', () => {
  describe.each([
    ['characterization の URL_ROWS と同じ形', URL_ROWS_SHAPES],
    ['h の値は書き換えない', HANDLE_ROWS],
    ['origin と pathname は完全一致', ORIGIN_AND_PATH_ROWS],
  ] as const)('%s', (_title, rows) => {
    it.each(rows)('$name', (row) => {
      expect(parseOwnOrderNotifyUrl(row.webhook, row.origin ?? ORIGIN)).toEqual(row.want);
    });
  });

  it('h がちょうど 1 つのとき、handles[0] は searchParams.get("h") と同じ値', () => {
    const rows = [...URL_ROWS_SHAPES, ...HANDLE_ROWS, ...ORIGIN_AND_PATH_ROWS];
    const single = rows.filter((row) => row.want.kind === 'own' && row.want.handles.length === 1);
    expect(single.length).toBeGreaterThan(10);
    for (const row of single) {
      const parsed = parseOwnOrderNotifyUrl(row.webhook, row.origin ?? ORIGIN);
      expect(parsed.kind === 'own' && parsed.handles[0]).toBe(new URL(row.webhook).searchParams.get('h'));
    }
  });

  it('呼ぶたびに新しい handles を返す (呼び出し側が書き換えても次の解析に残らない)', () => {
    const first = parseOwnOrderNotifyUrl(`${ORIGIN}/api/order/notify?h=alice`, ORIGIN);
    if (first.kind !== 'own') throw new Error('own のはず');
    first.handles.push('bob');
    expect(parseOwnOrderNotifyUrl(`${ORIGIN}/api/order/notify?h=alice`, ORIGIN)).toEqual(own('alice'));
  });
});

// =====================================================================================================================
// 柵: 5 つ目の実装を足させない
// =====================================================================================================================
// 「自社の notify の URL か」の解析は lib/order/ownNotifyUrl.ts だけ。client 側 (components/・hooks/・lib/) のコードに、
// path の文字列 `api/order/notify` が、宛先を組む形のほかで現れたら落とす (pathname との比較・endsWith・正規表現・定数への代入も)。
// コメントは見ない (構文木の文字列・テンプレート・正規表現だけ)。app/ (server の route) は見ない。
const NEEDLE = 'api/order/notify';
const OWN_PARSER_FILE = 'lib/order/ownNotifyUrl.ts';
const SCANNED_ROOTS = ['components', 'hooks', 'lib'];
// 宛先を組む形のうち `new URL('/api/order/notify', …)` はいくつあってもよい (下の isDestinationOfNewUrl)。
// それ以外の形で path の文字列を持ってよい所は、ここに 1 つずつ書く (file → その式の字)。
const ALLOWED_OTHER_USES: Record<string, string[]> = {
  // モバイル注文の画面が、/checkout へ渡す webhook の URL を組む (宛先。判定ではない)。
  'components/MobileOrderView.tsx': ['`${origin}/api/order/notify?h=${encodeURIComponent(handle)}`'],
};

type Use = { file: string; line: number; text: string; destination: boolean };

function isDestinationOfNewUrl(node: ts.Node): boolean {
  const parent = node.parent;
  return ts.isStringLiteralLike(node) && node.text === '/api/order/notify' &&
    ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'URL' &&
    parent.arguments?.[0] === node;
}

function usesOfNotifyPath(file: string, source: string): Use[] {
  const tree = parseSource(file, source);
  const found: Use[] = [];
  const visit = (node: ts.Node) => {
    const text =
      ts.isStringLiteralLike(node) ? node.text
        : ts.isTemplateExpression(node) ? node.getText(tree)
          // 正規表現の中の `\/` は `/` として読む。
          : ts.isRegularExpressionLiteral(node) ? node.text.replaceAll('\\/', '/')
            : null;
    if (text !== null && text.includes(NEEDLE)) {
      found.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        text: node.getText(tree),
        destination: isDestinationOfNewUrl(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

describe('柵: 自社の notify の URL の判定は parseOwnOrderNotifyUrl だけ', () => {
  const scan = (source: string) => usesOfNotifyPath('fake.ts', source);

  it.each([
    ['pathname との比較', "const own = url.pathname === '/api/order/notify';"],
    ['比較の左右が逆', "const own = '/api/order/notify' !== url.pathname;"],
    ['二重引用符', 'const own = url.pathname === "/api/order/notify";'],
    ['endsWith', "const own = url.pathname.endsWith('/api/order/notify');"],
    ['href の startsWith (テンプレート)', 'const own = url.href.startsWith(`${origin}/api/order/notify`);'],
    ['置換の無いテンプレート', 'const own = url.pathname === `/api/order/notify`;'],
    ['正規表現', 'const own = /^\\/api\\/order\\/notify$/.test(url.pathname);'],
    ['定数に置いてから比べる', "const NOTIFY_PATH = '/api/order/notify';\nconst own = url.pathname === NOTIFY_PATH;"],
    ['switch の case', "switch (url.pathname) { case '/api/order/notify': break; }"],
    ['new URL の 2 つ目の引数', "const url = new URL(path, '/api/order/notify');"],
    ['URL でない class の引数', "const url = new Request('/api/order/notify');"],
    ['new URL でも query つきの字', "const url = new URL('/api/order/notify?h=alice', origin);"],
  ])('判定に使える形は見つける: %s', (_name, source) => {
    const found = scan(source);
    expect(found).toHaveLength(1);
    expect(found[0].destination).toBe(false);
  });

  it.each([
    ['new URL の 1 つ目の引数', "const url = new URL('/api/order/notify', window.location.origin);"],
  ])('宛先を組む形は対象にしない: %s', (_name, source) => {
    expect(scan(source)).toEqual([expect.objectContaining({ destination: true })]);
  });

  it.each([
    ['行のコメント', "// url.pathname === '/api/order/notify'\nconst a = 1;"],
    ['範囲のコメント', "/* `/api/order/notify?h=` */\nconst a = 1;"],
    ['別の path', "const own = url.pathname === '/api/order/status';"],
  ])('コメントと別の path は拾わない: %s', (_name, source) => {
    expect(scan(source)).toEqual([]);
  });

  it('parser の file には、pathname との比較が 1 つだけある (この柵の探し方が本物の実装を拾う)', () => {
    const found = usesOfNotifyPath(OWN_PARSER_FILE, readSource(OWN_PARSER_FILE));
    expect(found.map((use) => use.text)).toEqual(["'/api/order/notify'"]);
    expect(found[0].destination).toBe(false);
  });

  it('components/・hooks/・lib/ に、宛先を組む形のほかで path の文字列が残っていない', () => {
    const files = SCANNED_ROOTS.flatMap(sourceFilesUnder).filter((file) => file !== OWN_PARSER_FILE);
    // 探す範囲が空になっていない (移した 3 つの呼び出し側を含む)。
    expect(files).toEqual(expect.arrayContaining([
      'components/CheckoutForm.tsx', 'hooks/useCheckoutOrderNotify.ts', 'lib/orderDeliveryContext.ts',
    ]));
    const uses = files.flatMap((file) => usesOfNotifyPath(file, readSource(file)));
    // 宛先を組む new URL は今もある (前の会計・束縛した注文の通知)。探し方が本物の file で効いている。
    expect(uses.filter((use) => use.destination).map((use) => use.file)).toContain('hooks/useCheckoutOrderNotify.ts');

    const others: Record<string, string[]> = {};
    for (const use of uses.filter((entry) => !entry.destination)) (others[use.file] ??= []).push(use.text);
    // 落ちたら: 「自社の notify の URL か」を見るなら lib/order/ownNotifyUrl.ts の parseOwnOrderNotifyUrl を使い、
    // 方針 (h の数・正規化) だけを呼び出し側に書く。宛先を組むなら new URL('/api/order/notify', origin)。
    // どちらでもない使い方を足すときだけ、ALLOWED_OTHER_USES に理由と一緒に書く。
    expect(others).toEqual(ALLOWED_OTHER_USES);
  });
});
