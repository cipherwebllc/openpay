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
// 柵: 5 つ目の実装が足されたら気づく (尽くしてはいない)
// =====================================================================================================================
// 「自社の notify の URL か」の解析は lib/order/ownNotifyUrl.ts だけ。client 側 (components/・hooks/・lib/) のコードに、
// path の文字列 `api/order/notify` が、宛先を組む形のほかで現れたら落とす (pathname との比較・endsWith・正規表現・定数への代入も)。
// コメントは見ない (構文木の文字列・テンプレート・正規表現だけ)。
//
// この柵が見ていないもの (ここを通れば 5 つ目の判定は書ける。素直に書いた 5 つ目に気づくための柵で、必ず止めるものではない):
//   - 文字列を分けて組む形 (`'/api/order/' + 'notify'`・`['api', 'order', 'notify'].join('/')` など)。
//   - app/ の中 (server の route と page)。見るのは SCANNED_ROOTS だけ。
//   - SCANNED_ROOTS の外 (app/・外の package) で定数にして、import して持ち込む形。
//   - 宛先として組んだ `new URL(…)` を変数に置き、別の文でその `.pathname` / `.origin` を比べる形
//     (同じ式の中で読む・比べる形だけ、下の comparesCreatedUrl が落とす)。
//   - 同じ式の中でも、宛先として組んだ `new URL(…)` をメソッドの引数に渡して比べる形
//     (`url.href.startsWith(new URL('/api/order/notify?h=alice', origin).href)`)。comparesCreatedUrl が見るのは
//     `.pathname` / `.origin` を読む形と、等号の比較の片側になる形だけ。
//   - 本物の file では、path の字を escape で書く形 (`'/api/order/notify'`)。本物の file は、先に中身の字で絞ってから
//     構文木にかけるので (下の mayUseNotifyPath)、source の字に path が現れない file は構文木を見ない。
const NEEDLE = 'api/order/notify';
// 本物の file を全部 構文木にかけると重い (CI は coverage つきで手元の数倍遅く、5 秒の timeout を超えた)。構文木にかけるのは、
// source の字に path が現れる file だけにする。正規表現の中の `\/` で書いた path も拾う。字が現れない file には、
// usesOfNotifyPath が拾うもの (文字列・テンプレート・正規表現の中の path) が無い (上の escape の形を除く)。
const MAY_USE_NOTIFY_PATH = /api\\?\/order\\?\/notify/;
const mayUseNotifyPath = (source: string) => MAY_USE_NOTIFY_PATH.test(source);
const NOTIFY_PATH = '/api/order/notify';
const OWN_PARSER_FILE = 'lib/order/ownNotifyUrl.ts';
const SCANNED_ROOTS = ['components', 'hooks', 'lib'];
// 宛先を組む `new URL('/api/order/notify…', …)` はいくつあってもよい (下の notifyDestinationNewUrl)。
// それ以外の形で path の文字列を持ってよい所は、ここに 1 つずつ書く (file → その式の字)。
const ALLOWED_OTHER_USES: Record<string, string[]> = {
  // モバイル注文の画面が、/checkout へ渡す webhook の URL を組む (宛先。判定ではない)。
  'components/MobileOrderView.tsx': ['`${origin}/api/order/notify?h=${encodeURIComponent(handle)}`'],
};
// 組んだ URL から読むと「判定」になる部分。
const COMPARED_PARTS = new Set(['pathname', 'origin']);
const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken,
]);

type Use = { file: string; line: number; text: string; destination: boolean };

// 宛先を組む形: `new URL(<ここ>, …)` の 1 つ目の引数で、path がちょうど '/api/order/notify' (後ろは無いか、query か fragment)。
// テンプレートは最初の `${` の前の字で見る (path の直後に置換が続く `/api/order/notify${x}` は、別の path になりうるので通さない)。
function notifyDestinationNewUrl(node: ts.Node): ts.NewExpression | null {
  const head = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.head.text : null;
  if (head === null || !head.startsWith(NOTIFY_PATH)) return null;
  const rest = head.slice(NOTIFY_PATH.length);
  if (!(ts.isTemplateExpression(node) ? /^[?#]/ : /^(?:[?#]|$)/).test(rest)) return null;
  const parent = node.parent;
  return ts.isNewExpression(parent) && ts.isIdentifier(parent.expression) && parent.expression.text === 'URL' &&
    parent.arguments?.[0] === node ? parent : null;
}

// 組んだ URL を、同じ式の中で判定に使っているか: `.pathname` / `.origin` を読む、または (`.href`・`.toString()` などを挟んでも)
// `===` / `!==` / `==` / `!=` の片側になる。宛先として使うだけ (変数に置く・fetch に渡す・文字列にする) なら false。
function comparesCreatedUrl(created: ts.NewExpression): boolean {
  let node: ts.Node = created;
  for (;;) {
    const parent = node.parent;
    if (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isSatisfiesExpression(parent) || ts.isNonNullExpression(parent)) {
      node = parent;
    } else if (ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (COMPARED_PARTS.has(parent.name.text)) return true;
      node = parent;
    } else if (ts.isElementAccessExpression(parent) && parent.expression === node) {
      if (ts.isStringLiteralLike(parent.argumentExpression) && COMPARED_PARTS.has(parent.argumentExpression.text)) return true;
      node = parent;
    } else if (ts.isCallExpression(parent) && parent.expression === node) {
      node = parent;
    } else {
      return ts.isBinaryExpression(parent) && EQUALITY_OPERATORS.has(parent.operatorToken.kind);
    }
  }
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
      const created = notifyDestinationNewUrl(node);
      found.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        text: node.getText(tree),
        destination: created !== null && !comparesCreatedUrl(created),
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
    // new URL の 1 つ目の引数でも、path が '/api/order/notify' ちょうどでないものは宛先として通さない。
    ['new URL の path の後ろに別の segment', "const url = new URL('/api/order/notify/extra', origin);"],
    ['new URL の path の後ろに字が続く', "const url = new URL('/api/order/notifyx', origin);"],
    ['new URL の path の直後に置換が続くテンプレート', 'const url = new URL(`/api/order/notify${suffix}`, origin);'],
    ['new URL の path の前に別の segment', "const url = new URL('/ja/api/order/notify', origin);"],
  ])('判定に使える形は見つける: %s', (_name, source) => {
    const found = scan(source);
    expect(found).toHaveLength(1);
    expect(found[0].destination).toBe(false);
  });

  // (a) 宛先を組む new URL は、query つき・fragment つき・テンプレートでも通す。組んだものを宛先として使うだけなら通す。
  it.each([
    ['new URL の 1 つ目の引数', "const url = new URL('/api/order/notify', window.location.origin);"],
    ['query つきの字', "const url = new URL('/api/order/notify?h=alice', origin);"],
    ['fragment つきの字', "const url = new URL('/api/order/notify#x', origin);"],
    ['query を置換で組むテンプレート', 'const url = new URL(`/api/order/notify?h=${encodeURIComponent(handle)}`, origin);'],
    ['置換の無いテンプレート', 'const url = new URL(`/api/order/notify`, origin);'],
    ['組んでから searchParams に足す', "const url = new URL('/api/order/notify', origin);\nurl.searchParams.set('h', handle);"],
    ['文字列にして変数に置く (toString)', "const target = new URL('/api/order/notify', origin).toString();"],
    ['文字列にして変数に置く (href)', "const target = new URL('/api/order/notify?h=alice', origin).href;"],
    ['fetch に渡す', "void fetch(new URL('/api/order/notify', origin), { method: 'POST' });"],
    ['searchParams を読む', "const h = new URL('/api/order/notify?h=alice', origin).searchParams.get('h');"],
  ])('(a) 宛先を組む形は対象にしない: %s', (_name, source) => {
    expect(scan(source)).toEqual([expect.objectContaining({ destination: true })]);
  });

  // (b) 宛先の形の new URL でも、組んだものを同じ式の中で判定に使えば落とす (前は「宛先」として通っていた)。
  it.each([
    ['pathname を読んで比べる', "const own = url.origin === origin && url.pathname === new URL('/api/order/notify', origin).pathname;"],
    ['比較の左右が逆', "const own = new URL('/api/order/notify', origin).pathname !== url.pathname;"],
    ['origin を読んで比べる', "const own = url.origin === new URL('/api/order/notify?h=alice', origin).origin;"],
    ['pathname を読んで変数に置く', "const path = new URL('/api/order/notify', origin).pathname;"],
    ['pathname を [] で読む', "const path = new URL('/api/order/notify', origin)['pathname'];"],
    ['括弧と as を挟んで pathname を読む', "const path = (new URL('/api/order/notify', origin) as URL).pathname;"],
    ['pathname を読んでから method を呼ぶ', "const own = new URL('/api/order/notify', origin).pathname.endsWith(url.pathname);"],
    ['href を比べる', "const own = url.href === new URL('/api/order/notify', origin).href;"],
    ['toString を比べる', "const own = webhook === new URL('/api/order/notify?h=alice', origin).toString();"],
    ['緩い比較 (!=)', "const other = webhook != new URL('/api/order/notify', origin).href;"],
    ['テンプレートで組んで比べる', 'const own = webhook === new URL(`/api/order/notify?h=${handle}`, origin).href;'],
  ])('(b) 組んだ URL を同じ式の中で判定に使う形は見つける: %s', (_name, source) => {
    const found = scan(source);
    expect(found).toHaveLength(1);
    expect(found[0].destination).toBe(false);
  });

  // 柵の限界 (冒頭のコメント) を、通ってしまう例として固定する。ここが落ちたら、柵が広がったので冒頭のコメントを直す。
  it.each([
    ['文字列を分けて組む', "const own = url.pathname === '/api/order/' + 'notify';", []],
    ['変数に置いた new URL を別の文で比べる', "const target = new URL('/api/order/notify', origin);\nconst own = url.pathname === target.pathname;", [true]],
    ['組んだ new URL をメソッドの引数に渡して比べる', "const own = url.href.startsWith(new URL('/api/order/notify?h=alice', origin).href);", [true]],
  ])('見ていない形 (通ってしまう): %s', (_name, source, destinations) => {
    expect(scan(source).map((use) => use.destination)).toEqual(destinations);
  });

  // 本物の file を構文木にかける前の、字での絞り込み。scanner が拾う形は、絞り込みも通す。
  it.each([
    ['pathname との比較', "const own = url.pathname === '/api/order/notify';", true],
    ['宛先を組むテンプレート', 'const target = `${origin}/api/order/notify?h=${handle}`;', true],
    ['正規表現 (\\/ で書いた path)', 'const own = /^\\/api\\/order\\/notify$/.test(url.pathname);', true],
    ['コメントだけ (構文木にかけるが、scanner は拾わない)', "// '/api/order/notify'\nconst a = 1;", true],
    ['path の字が無い', "const own = url.pathname === '/api/order/status';", false],
    ['文字列を分けて組む (見ていない形)', "const own = url.pathname === '/api/order/' + 'notify';", false],
  ])('字での絞り込み: %s', (_name, source, expected) => {
    expect(mayUseNotifyPath(source)).toBe(expected);
    // 絞り込みが外す source には、scanner が拾うものも無い。
    if (!expected) expect(scan(source)).toEqual([]);
  });

  it('字での絞り込みの限界: path の字を escape で書くと、scanner は拾うが、絞り込みで外れる (本物の file では見ない)', () => {
    const source = "const own = url.pathname === '/api/order/noti\\u0066y';";
    expect(scan(source)).toHaveLength(1);
    expect(mayUseNotifyPath(source)).toBe(false);
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
    // 探す範囲が空になっていない (移した 3 つの呼び出し側を含む・2026-11-14 時点で 822 file)。
    expect(files.length).toBeGreaterThan(500);
    expect(files).toEqual(expect.arrayContaining([
      'components/CheckoutForm.tsx', 'hooks/useCheckoutOrderNotify.ts', 'lib/orderDeliveryContext.ts',
    ]));
    // 構文木にかけるのは、source の字に path が現れる file だけ (2026-11-14 時点で 8 file)。宛先を組む 2 つの file は残る。
    const candidates = files.filter((file) => mayUseNotifyPath(readSource(file)));
    expect(candidates).toEqual(expect.arrayContaining(['hooks/useCheckoutOrderNotify.ts', 'components/MobileOrderView.tsx']));
    const uses = candidates.flatMap((file) => usesOfNotifyPath(file, readSource(file)));
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
