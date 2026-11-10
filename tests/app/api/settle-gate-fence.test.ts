// @vitest-environment node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { posix } from 'node:path';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

// 何を守るか (全レビュー第 10 回 E-1・money-path):
//   creator-store の hosted intent の署名 (receiveWithAuthorization・to=forwarder・nonce に server 発行の intentSalt) を
//   broadcast できる入口は、broadcast の前に必ず checkHostedIntentSettleAdmission (lib/x402/purchaseSettleGate.ts) を呼ぶ。
//   呼び忘れた入口が 1 つあると、quoted のままの署名を直接 broadcast でき、hosted route の CAS (quoted→signed→settling) を
//   飛ばせる。既存のテスト (settle-hosted-gate・relay-jpyc-hosted-gate・relay-move) は今ある入口の応答しか見ないので、
//   入口が増えたときの付け忘れはここで止める。
//
// どう見るか:
//   app/ の全 route.ts(x) から、実行時の参照を top-level の宣言の単位で推移的にたどる (import の別名・再 export・
//   export *・namespace import・import() / require()・module の初期化コード)。出口に届いたら、出口を直接参照している宣言
//   (= 呼び出し点。route の中でも、route が通る共有の関数でもよい) を記録する。出口の中はたどらない。
//   - 関数の中身と class の instance の property の初期化は、その宣言の名前が参照されたときにたどる。それ以外は module の
//     初期化 ('<init>'。import されたら名前を使わなくても走る) に数える: 宣言でない文・変数の初期化式・class の static の
//     初期化・初期化の間に呼ぶ関数へ渡した callback と即時に呼ぶ関数 (渡した先がすぐ呼ぶかは見ずに、走るとみなす)。
//     初期化から名前を使わずに走る先 (static block の this.run()・初期化の中で作る object の getter / setter) はたどらず、
//     throw で落とす。ただし関数の呼び出しの引数の中にある getter / setter (例 Object.freeze({ get run() {…} }).run) は
//     落とさない: 上の「渡した callback」と同じく、中身を初期化のコードとしてたどる (出口を呼んでいれば '<init>' の
//     呼び出し点になる)。
//   - forwarder の出口の呼び出し点は、同じ宣言の中で、出口より前にゲートを呼ぶ。ゲートと同じ名前を同じ top-level の文の
//     中で宣言し直している (局所の関数・変数・引数。どの scope かは見ない) ときは、ゲートの呼び出しとみなさない。
//   - それ以外の出口の呼び出し点は、理由つきの allowlist に載っている。
//   たどれない書き方 (行き先が文字列でない import() / require()・解決できない import と export・上の初期化の 2 つ) は
//   throw で落とす。
//
// 出口の一覧 (2026-11-11 に lib/ と app/ の sendRawTransaction / sendTransaction / writeContract / Gelato の fetch を読んで列挙):
//   JPYC を relayer から broadcast できるのは次の 2 か所だけ。
//   - lib/relay/relayProvider.ts selfHostIoFor: relayer の鍵 (RELAYER_PRIVATE_KEY) で署名し sendRawTransaction する IO を作る。
//   - lib/relay/relayProvider.ts gelatoSubmit (非公開): Gelato の sponsored-call。relayFreeAuthorization だけが使う。
//   その上に重なる関数も出口として数える (入口が上の層を飛ばして下の層を直接組み立てても、どれかに当たる)。
//   - forwarder (hosted intent の署名が通る。ゲートが要る)
//       lib/relay/forwarderSettleService.ts settleViaForwarder — forwarder.settle の検証と broadcast
//       lib/relay/forwarderRecover.ts recoverViaForwarder — その DI のコア (submit を差し込めば broadcast する)
//   - free (transferWithAuthorization だけを送る)
//       lib/relay/relayProvider.ts relayFreeAuthorization — self-host / Gelato の両方
//       lib/relay/jpycRelay.ts relayJpycAuthorization — その DI のコア
//   - raw (calldata を選ばない)
//       lib/relay/relayBroadcast.ts relayBroadcast — 冪等・予算・submit・poll の共通の手順
//       lib/relay/selfHostRelayer.ts submitSelfHost — 見積もり・署名・sendRawTransaction
//       lib/relay/relayProvider.ts selfHostIoFor — 上記
//   出口の一覧の漏れは 3 つ目のテストが見る: route から実行時に読み込まれる file の宣言 (file#宣言) のうち、broadcast の
//   primitive が出てくるものを固定する。primitive = viem の送信の関数名 (BROADCAST_PRIMITIVE)・それを別名で import した
//   名前・同じ名前の文字列 (`wallet['sendTransaction']`)・生の RPC の送信の method 名 (`eth_send…` / `wallet_send…`)・
//   viem の getContract の write の形 (`.write.<名前>` / `.write[…]`。import の有無では絞らない)。primitive を再 export
//   した file は、その file の '<init>' に数える。出口 (EXITS) でない宣言には理由が要るので、承認済みの file に送信の関数を
//   1 つ足しても、その宣言が現れて落ちる。
//
// この柵が見ないもの:
//   この柵は、route が既知の出口・既知の primitive の形で JPYC を送ることを見張る。SDK の内部や、実行時に組み立てた名前までは
//   追わない。新しい送信の形 (SDK・RPC の method・関数名) を入れるときは、BROADCAST_PRIMITIVE などの一覧に足す。
//   - ゲートの結果の扱い (denied / storage で止めるか) と、ゲートの呼び出しが必ず実行されるか。見るのは「同じ宣言の中で、
//     出口より前にゲートの呼び出しが書かれている」ことだけ (分岐の中にあっても通る)。応答は
//     tests/app/api/settle-hosted-gate.test.ts・relay-jpyc-hosted-gate.test.ts・relay-move.test.ts が見る。
//   - route handler でない入口。server action ('use server') は 2026-11-11 時点で 0 個。足すときは入口に加える。
//   - fetch で外の relayer を呼ぶ新しい出口 (関数名では見つからない)。Gelato は relayFreeAuthorization の中だけ。
//   - 実行時に組み立てた名前での送信 (`wallet[name]()` の name を文字列の連結や入力から作る・eval)。primitive の名前が、
//     識別子か文字列のまま route から読み込まれる code のどこかに出てくることを前提にしている。
//   - npm の package の中の、上の名前と形を使わない送信 (例: ほかの SDK の送信の関数・`const w = contract.write; w.settle()`)。
//   - 理由つきの宣言 (NON_JPYC_PRIMITIVE_DECLS) の中に足した JPYC の送信。その宣言の中身は人が読む。
//   - 局所の shadowing はゲートの名前だけを見る。出口と同じ名前の局所の束縛は出口とみなす (落ちる側に倒れる)。

const ROOT = process.cwd();
const GATE = 'lib/x402/purchaseSettleGate.ts#checkHostedIntentSettleAdmission';

type ExitKind = 'forwarder' | 'free' | 'raw';
const EXITS: Record<string, ExitKind> = {
  'lib/relay/forwarderSettleService.ts#settleViaForwarder': 'forwarder',
  'lib/relay/forwarderRecover.ts#recoverViaForwarder': 'forwarder',
  'lib/relay/relayProvider.ts#relayFreeAuthorization': 'free',
  'lib/relay/jpycRelay.ts#relayJpycAuthorization': 'free',
  'lib/relay/relayBroadcast.ts#relayBroadcast': 'raw',
  'lib/relay/selfHostRelayer.ts#submitSelfHost': 'raw',
  'lib/relay/relayProvider.ts#selfHostIoFor': 'raw',
};

// forwarder の出口の呼び出し点 (どれもゲートを先に呼ぶ)。ゲートを通す新しい呼び出し点を足したら、ここと
// lib/x402/purchaseSettleGate.ts の冒頭の「現在の入口」に足す (money-path の入口が増えたことを人が見る・掟 15)。
// app/api/paid/**・app/api/agent-order/pay は facilitator/settle の POST を同じプロセスで呼ぶので、呼び出し点は増えない。
const GATED_CALL_SITES = [
  'app/api/facilitator/settle/route.ts#POST -> settleViaForwarder',
  'app/api/relay/jpyc/move/route.ts#POST -> settleViaForwarder',
  'app/api/relay/jpyc/route.ts#handleRecover -> settleViaForwarder',
];

// ゲートを通らないのが正しい呼び出し点と、その理由。載っていない呼び出し点が現れても、載っているものが消えても落ちる。
const UNGATED_CALL_SITES: Record<string, string> = {
  'app/api/relay/jpyc/route.ts#handleFree -> relayFreeAuthorization':
    'free の経路は transferWithAuthorization の署名を recover==from で検証する (lib/relay/jpycRelay.ts の ' +
    'recoverTransferAuthorizationSigner)。hosted intent の署名は ReceiveWithAuthorization (to=forwarder・nonce=コミットメント) で ' +
    'EIP-712 の型が違うので、ここに出しても signature_mismatch で broadcast の前に落ちる。ゲートの入力 (intentSalt) もこの経路には無い。',
  'app/api/csv-pass/relay/route.ts#POST -> relayFreeAuthorization':
    '同じ free の出口 (hosted intent の署名は型が違い検証を通らない)。加えて宛先はサーバーが feeReceiver に固定し、' +
    '額は csvPassPriceWei・from は SIWE の session に限る。',
  'app/api/relay/jpyc/health/route.ts#probe -> selfHostIoFor':
    'relayer の native 残高を getBalance で読むだけ。submit を呼ばない (sendRawTransaction を書くと 3 つ目のテストが落ちる)。',
};

// broadcast の primitive (viem の wallet の送信の action の名前と、JSON-RPC の送信の method 名)。
const BROADCAST_PRIMITIVE = /^(?:send(?:Raw)?Transaction(?:Sync)?|writeContract(?:Sync)?|deployContract|sendCalls|sendUserOperation)$/;
const RPC_SEND = /^(?:eth|wallet)_send\w*$/;
// route から実行時に読み込まれる宣言のうち、primitive が出てくる出口 (EXITS の中)。JPYC を relayer の鍵で送るのはここだけ。
const PRIMITIVE_EXITS = [
  'lib/relay/relayProvider.ts#selfHostIoFor', // relayer の鍵で sendRawTransaction する IO を作る
  'lib/relay/selfHostRelayer.ts#submitSelfHost', // IO の sendRawTransaction を呼ぶ
];
// primitive が出てくるが出口でない宣言と、JPYC を送らない理由。新しい宣言が現れたら、JPYC を送るなら EXITS と
// PRIMITIVE_EXITS に足し (呼び出し点が上の 2 つの一覧で分類される)、送らないなら理由とともにここへ足す。
const NON_JPYC_PRIMITIVE_DECLS: Record<string, string> = {
  'lib/license/minter.ts#processJob':
    'JPYC を送らない。利用ライセンス NFT の registerLicense / mintFor だけを、relayer と別の鍵 (LICENSE_MINTER_PRIVATE_KEY・' +
    'relayer と同じ鍵は minterAccount が拒む) で license の contract へ送る。',
};

// ---- 参照のグラフ ----------------------------------------------------------------------------------------------

// local = 同じ top-level の文の中で、この名前を宣言し直している (ゲートの呼び出しとして数えない)。
type Ref = { pos: number; call: boolean; local: boolean; name?: string; member?: string; module?: string };
type Binding = { from: string; name: string }; // name '*' = module 全体 (namespace)
type Mod = {
  imports: Map<string, Binding>; // local 名 → 取り込み元 (repo の中だけ。npm の package は持たない)
  exports: Map<string, Binding | { local: string } | null>; // null = npm の package からの再 export
  stars: (string | null)[]; // export * from (null = npm の package)
  deps: string[]; // 実行時に読み込む repo の中の file
  decls: Map<string, Ref[]>; // top-level の宣言 → その名前が参照されたときに走る参照。'<init>' = module の初期化で走る参照
  primitives: Set<string>; // broadcast の primitive が出てくる decls の key
};

const SOURCE = /\.(?:tsx?|m?js)$/; // json などは参照を持たない
const INIT = '<init>';
const DEFAULT = '<default>';

function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isBindingElement(el) ? boundNames(el.name) : []));
}

function parseModule(file: string, source: string, resolveSpec: (spec: string) => string | null): Mod {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  // file ごとに 1 回だけ parse する (実行時に読み込む file = deps も同じ構文木から集める。数え方は
  // tests/_helpers/runtimeImports.ts の runtimeSpecifiers と同じ: 型だけの import / export を除く・副作用 import を含む)。
  const mod: Mod = { imports: new Map(), exports: new Map(), stars: [], deps: [], decls: new Map(), primitives: new Set() };

  // primitive を別名で取り込んだ名前 (`import { sendTransaction as broadcast } from 'viem/actions'` の broadcast)。
  const aliases = new Set<string>();
  for (const st of parsed.statements) {
    const named = ts.isImportDeclaration(st) ? st.importClause?.namedBindings : undefined;
    if (!named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      if (BROADCAST_PRIMITIVE.test((el.propertyName ?? el.name).text)) aliases.add(el.name.text);
    }
  }
  const primitiveName = (text: string) => BROADCAST_PRIMITIVE.test(text) || aliases.has(text);
  const isPrimitive = (node: ts.Node) =>
    (ts.isIdentifier(node) && primitiveName(node.text)) ||
    (ts.isStringLiteralLike(node) && (BROADCAST_PRIMITIVE.test(node.text) || RPC_SEND.test(node.text))) ||
    // viem の getContract の write (`contract.write.settle(…)`・`contract.write['settle'](…)`)。中で writeContract を呼ぶ。
    ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'write');

  const refsOf = (decl: string) => {
    let refs = mod.decls.get(decl);
    if (!refs) mod.decls.set(decl, (refs = []));
    return refs;
  };
  const isCallee = (node: ts.Node) => ts.isCallExpression(node.parent) && node.parent.expression === node;
  // 宣言と property の名前 (`const a`・`function a`・引数の a・`x.a`・`{ a: … }`) は束縛への参照ではない。`{ a }` の a は参照。
  const isName = (node: ts.Identifier) =>
    !ts.isShorthandPropertyAssignment(node.parent) && (node.parent as { name?: ts.Node }).name === node;
  const binds = (node: ts.Node) =>
    ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) || ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node);
  const localNames = (root: ts.Node) => {
    const names = new Set<string>();
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && isName(node) && binds(node.parent)) names.add(node.text);
      ts.forEachChild(node, visit);
    };
    visit(root);
    return names;
  };
  const deferredBody = (node: ts.Node) =>
    ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    (ts.isPropertyDeclaration(node) && !(ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword));
  const startsCall = (node: ts.Node) =>
    ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isDecorator(node);

  // top-level の文 1 つの参照を、その文の宣言 (names) が参照されたときに走るものと、module の初期化 (INIT) で走るものに分ける。
  const walk = (root: ts.Node, names: string[]) => {
    const later = names.length ? names : [INIT];
    const locals = localNames(root);
    const visit = (node: ts.Node, deferred: boolean, inCall: boolean) => {
      // 型の位置は実行時の参照ではない (class の extends は式なのでたどる)。
      if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
      // module の初期化の中の this (class の static block から this.run() で static method を呼ぶ等) と、初期化の中で作る
      // object の getter / setter (`{ get run() { … } }.run`) は、走る先を名前でたどれない → 落とす (2026-11-11 時点で 0 件)。
      if (!deferred && node.kind === ts.SyntaxKind.ThisKeyword) throw new Error(`module の初期化の this は追えない (${file})`);
      if (
        !deferred && !inCall && (ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) &&
        ts.isObjectLiteralExpression(node.parent)
      ) {
        throw new Error(`module の初期化の object の getter / setter は追えない (${file})`);
      }
      const decls = deferred ? later : [INIT];
      const push = (ref: Omit<Ref, 'local'>) => {
        const local = ref.name !== undefined && locals.has(ref.name);
        for (const decl of decls) refsOf(decl).push({ ...ref, local });
      };
      const primitive = (...nodes: ts.Node[]) => {
        if (nodes.some(isPrimitive)) for (const decl of decls) mod.primitives.add(decl);
      };
      primitive(node);
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      ) {
        // 行き先を静的に決められない import() / require() はたどれない → 落とす。
        const [spec] = node.arguments;
        if (!spec || !ts.isStringLiteralLike(spec)) throw new Error(`non-literal import()/require() in ${file}`);
        // 読み込んだ module のどの export を使うかは追わず、全部を参照したとみなす。
        const target = resolveSpec(spec.text);
        if (target) {
          mod.deps.push(target);
          push({ module: target, pos: node.getStart(), call: false });
        }
        return;
      }
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
        primitive(node.expression, node.name);
        push({ name: node.expression.text, member: node.name.text, pos: node.getStart(), call: isCallee(node) });
        return;
      }
      if (ts.isIdentifier(node)) {
        if (!isName(node)) push({ name: node.text, pos: node.getStart(), call: isCallee(node) });
        return;
      }
      if (deferredBody(node)) {
        // 関数の中身 (instance の property は new のとき) は、名前が参照されたときに走る。初期化の間に呼ぶ関数へ渡したもの・
        // 即時に呼ぶもの (inCall) は、初期化で走るとみなす。名前 (computed) と decorator は定義のときに走る。
        const body = deferred || !inCall;
        const named = (node as ts.NamedDeclaration).name;
        ts.forEachChild(node, (child) => visit(child, child === named || ts.isDecorator(child) ? deferred : body, inCall));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, deferred, inCall || startsCall(node)));
    };
    visit(root, false, false);
  };

  for (const st of parsed.statements) {
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      const from = clause?.isTypeOnly ? null : resolveSpec((st.moduleSpecifier as ts.StringLiteral).text);
      if (!from) continue;
      mod.deps.push(from); // 副作用 import (`import '…'`) も初期化が走る
      if (!clause) continue;
      if (clause.name) mod.imports.set(clause.name.text, { from, name: 'default' });
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) mod.imports.set(named.name.text, { from, name: '*' });
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          if (!el.isTypeOnly) mod.imports.set(el.name.text, { from, name: (el.propertyName ?? el.name).text });
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(st)) {
      if (st.isTypeOnly) continue;
      const from = st.moduleSpecifier ? resolveSpec((st.moduleSpecifier as ts.StringLiteral).text) : undefined;
      if (from) mod.deps.push(from);
      const clause = st.exportClause;
      if (!clause) mod.stars.push(from ?? null);
      else if (ts.isNamespaceExport(clause)) mod.exports.set(clause.name.text, from ? { from, name: '*' } : null);
      else {
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue;
          const original = (el.propertyName ?? el.name).text;
          mod.exports.set(el.name.text, from === undefined ? { local: original } : from ? { from, name: original } : null);
          // primitive を名前を変えて中継されると、使う側の名前では見つからない。中継した file の初期化に数える。
          if (primitiveName(original)) mod.primitives.add(INIT);
        }
      }
      continue;
    }
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) continue;
    const modifiers = ts.canHaveModifiers(st) ? ts.getModifiers(st) ?? [] : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const declare = (names: string[], root: ts.Node) => {
      for (const name of names) {
        refsOf(name);
        if (ts.isExportAssignment(st)) mod.exports.set('default', { local: name });
        else if (exported) mod.exports.set(isDefault ? 'default' : name, { local: name });
      }
      walk(root, names);
    };
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) declare(boundNames(d.name), d);
    else if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) declare([st.name?.text ?? DEFAULT], st);
    else if (ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) declare([st.name.text], st);
    else if (ts.isExportAssignment(st)) declare([DEFAULT], st);
    else walk(st, []); // 宣言でない top-level の文
  }
  return mod;
}

const EMPTY: Mod = { imports: new Map(), exports: new Map(), stars: [], deps: [], decls: new Map(), primitives: new Set() };
const realModules = new Map<string, Mod>();

type CallSite = { site: string; kind: ExitKind; gated: boolean; routes: string[] };

/**
 * routes (repo 相対) から出口の呼び出し点を集める。overlay は「path → 中身」の仮の file (テスト用の偽の route と lib)。
 * 実在の file と同じ path は置かない。
 */
function analyze(routes: string[], overlay: Record<string, string> = {}) {
  const overlayModules = new Map<string, Mod>();
  const isFile = (file: string) => file in overlay || (existsSync(posix.join(ROOT, file)) && statSync(posix.join(ROOT, file)).isFile());
  const resolveFrom = (from: string) => (spec: string): string | null => {
    const base = spec.startsWith('@/')
      ? spec.slice(2)
      : spec.startsWith('.') ? posix.join(posix.dirname(from), spec) : null;
    if (base === null) return null; // npm の package
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (isFile(base + ext)) return base + ext;
    }
    throw new Error(`unresolved import ${spec} from ${from}`);
  };
  const load = (file: string): Mod => {
    if (!SOURCE.test(file)) return EMPTY;
    const cache = file in overlay ? overlayModules : realModules;
    let mod = cache.get(file);
    if (!mod) {
      mod = parseModule(file, overlay[file] ?? readFileSync(posix.join(ROOT, file), 'utf8'), resolveFrom(file));
      cache.set(file, mod);
    }
    return mod;
  };

  const allExports = (file: string, seen = new Set<string>()): string[] => {
    if (seen.has(file)) return [];
    seen.add(file);
    const mod = load(file);
    return [
      ...[...mod.exports.keys()].flatMap((name) => resolveExport(file, name)),
      ...mod.stars.flatMap((star) => (star ? allExports(star, seen) : [])),
    ];
  };
  // export 名 → 宣言の node (`file#名前`)。再 export と「import してから export」を宣言までたどる。undefined = その名前の export が無い。
  const findExport = (file: string, name: string, seen = new Set<string>()): string[] | undefined => {
    if (seen.has(file)) return undefined; // export * の循環
    seen.add(file);
    const mod = load(file);
    const entry = mod.exports.get(name);
    if (entry === null) return [];
    if (entry) {
      const binding = 'local' in entry ? mod.imports.get(entry.local) : entry;
      if (binding) return binding.name === '*' ? allExports(binding.from) : resolveExport(binding.from, binding.name);
      const { local } = entry as { local: string };
      return mod.decls.has(local) ? [`${file}#${local}`] : [];
    }
    for (const star of mod.stars) {
      const hit = star ? findExport(star, name, seen) : undefined;
      if (hit) return hit;
    }
    // npm の package を export * している module は、無い名前を package のものとみなす。
    return mod.stars.includes(null) ? [] : undefined;
  };
  const resolveExport = (file: string, name: string): string[] => {
    if (!SOURCE.test(file)) return [];
    const hit = findExport(file, name);
    if (!hit) throw new Error(`unresolved export ${name} of ${file}`);
    return hit;
  };
  const targets = (file: string, ref: Ref): string[] => {
    if (ref.module) return allExports(ref.module);
    const mod = load(file);
    const name = ref.name as string;
    const binding = mod.imports.get(name);
    if (!binding) return mod.decls.has(name) ? [`${file}#${name}`] : [];
    if (binding.name !== '*') return resolveExport(binding.from, binding.name);
    return ref.member ? resolveExport(binding.from, ref.member) : allExports(binding.from);
  };
  const split = (node: string): [string, string] => {
    const at = node.lastIndexOf('#');
    return [node.slice(0, at), node.slice(at + 1)];
  };

  // 出口かゲートの名前や場所が変わると、参照が出口に当たらなくなる。黙って素通しにしない。
  for (const node of [...Object.keys(EXITS), GATE]) {
    const [file, name] = split(node);
    if (!load(file).decls.has(name)) throw new Error(`${node} が無い (EXITS / GATE を実体に合わせる)`);
  }

  const sites = new Map<string, { kind: ExitKind; gated: boolean; routes: Set<string> }>();
  const files = new Set<string>();
  for (const route of routes) {
    const seenNodes = new Set<string>();
    const seenFiles = new Set<string>();
    const queue: string[] = [];
    // import した module は初期化コードが走る (どの名前を使うかによらない)。
    const enter = (file: string) => {
      if (seenFiles.has(file)) return;
      seenFiles.add(file);
      files.add(file);
      queue.push(`${file}#${INIT}`);
      for (const dep of load(file).deps) enter(dep);
    };
    enter(route);
    for (const decl of load(route).decls.keys()) queue.push(`${route}#${decl}`);
    for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
      if (seenNodes.has(node)) continue;
      seenNodes.add(node);
      const [file, decl] = split(node);
      enter(file);
      const refs = load(file).decls.get(decl) ?? [];
      for (const ref of refs) {
        for (const target of targets(file, ref)) {
          const kind = EXITS[target];
          if (!kind) {
            queue.push(target);
            continue;
          }
          // 同じ宣言の中で、この参照より前にゲートを呼んでいるか (import しただけ・後ろで呼ぶ・別の関数で呼ぶ・
          // 同じ名前の局所の束縛を呼ぶ は数えない)。
          const gated = refs.some((r) => {
            if (!r.call || r.local || r.pos >= ref.pos) return false;
            const called = targets(file, r);
            return called.length === 1 && called[0] === GATE;
          });
          const key = `${node} -> ${split(target)[1]}`;
          const site = sites.get(key) ?? { kind, gated: true, routes: new Set<string>() };
          site.gated &&= gated;
          site.routes.add(route);
          sites.set(key, site);
        }
      }
    }
  }
  const callSites: CallSite[] = [...sites]
    .map(([site, s]) => ({ site, kind: s.kind, gated: s.gated, routes: [...s.routes].sort() }))
    .sort((a, b) => (a.site < b.site ? -1 : 1));
  return {
    callSites,
    primitiveDecls: [...files].flatMap((file) => [...load(file).primitives].map((decl) => `${file}#${decl}`)).sort(),
  };
}

function routeFiles(dir = 'app'): string[] {
  return readdirSync(posix.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = posix.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return /^route\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('settle の入口は hosted intent のゲートを通る (構造の柵)', () => {
  let real: ReturnType<typeof analyze>;
  beforeAll(() => {
    real = analyze(routeFiles());
  }, 120_000);

  it('forwarder の出口の呼び出し点は、出口より前にゲートを呼ぶ', () => {
    const forwarder = real.callSites.filter((s) => s.kind === 'forwarder');
    expect(forwarder.filter((s) => !s.gated).map((s) => s.site)).toEqual([]);
    expect(forwarder.map((s) => s.site)).toEqual([...GATED_CALL_SITES].sort());
  });

  it('ゲートを通らない出口の呼び出し点は、理由つきの allowlist と一致する', () => {
    const others = real.callSites.filter((s) => s.kind !== 'forwarder').map((s) => s.site);
    expect(others).toEqual(Object.keys(UNGATED_CALL_SITES).sort());
  });

  it('route から読み込まれる宣言で broadcast の primitive が出てくるのは、出口か、理由つきの宣言だけ', () => {
    expect(real.primitiveDecls.filter((decl) => decl in EXITS)).toEqual([...PRIMITIVE_EXITS].sort());
    expect(real.primitiveDecls.filter((decl) => !(decl in EXITS))).toEqual(Object.keys(NON_JPYC_PRIMITIVE_DECLS).sort());
  });
});

// 上の 3 つは「今の route に穴が無い」ことしか言わない。柵が新しい入口を本当に見つけるかは、偽の route と偽の lib を
// メモリの上に置いて確かめる (disk には書かない。app/ を歩くほかのテストに見せないため)。
describe('settle の柵のたどり方 (偽の route)', () => {
  const SETTLE = '@/lib/relay/forwarderSettleService';
  const PROVIDER = '@/lib/relay/relayProvider';
  const GATE_MODULE = '@/lib/x402/purchaseSettleGate';
  const ROUTE = 'app/api/fence-fixture/route.ts';
  const verdicts = (files: Record<string, string>) => {
    const routes = Object.keys(files).filter((file) => file.startsWith('app/'));
    return Object.fromEntries(
      analyze(routes, files).callSites.map((s) => [s.site, s.kind === 'forwarder' ? (s.gated ? 'gated' : 'ungated') : s.kind]),
    );
  };

  it.each<[string, Record<string, string>, Record<string, string>]>([
    [
      '別名の import',
      {
        [ROUTE]: `import { settleViaForwarder as go } from '${SETTLE}';
          export const POST = (input: never) => go(input);`,
      },
      { [`${ROUTE}#POST -> settleViaForwarder`]: 'ungated' },
    ],
    [
      '再 export (名前を変える・export *・import してから export) を 3 段',
      {
        'lib/fenceFixture/a.ts': `import { settleViaForwarder } from '${SETTLE}';
          export { settleViaForwarder as go };`,
        'lib/fenceFixture/b.ts': "export * from './a';",
        'lib/fenceFixture/c.ts': "export { go as run } from './b';",
        [ROUTE]: `import { run } from '@/lib/fenceFixture/c';
          export const POST = (input: never) => run(input);`,
      },
      { [`${ROUTE}#POST -> settleViaForwarder`]: 'ungated' },
    ],
    [
      'namespace import',
      {
        [ROUTE]: `import * as settle from '${SETTLE}';
          export const POST = (input: never) => settle.settleViaForwarder(input);`,
      },
      { [`${ROUTE}#POST -> settleViaForwarder`]: 'ungated' },
    ],
    [
      'import()',
      {
        [ROUTE]: `export async function POST(input: never) {
            const { settleViaForwarder } = await import('${SETTLE}');
            return settleViaForwarder(input);
          }`,
      },
      { [`${ROUTE}#POST -> settleViaForwarder`]: 'ungated' },
    ],
    [
      'route が通る共有の関数 (ゲートなし)',
      {
        'lib/fenceFixture/pay.ts': `import { settleViaForwarder } from '${SETTLE}';
          export const pay = (input: never) => settleViaForwarder(input);`,
        [ROUTE]: `import { pay } from '@/lib/fenceFixture/pay';
          export const POST = (input: never) => pay(input);`,
      },
      { 'lib/fenceFixture/pay.ts#pay -> settleViaForwarder': 'ungated' },
    ],
    [
      'route が通る共有の関数 (ゲートを別名で import して先に呼ぶ)',
      {
        'lib/fenceFixture/pay.ts': `import { settleViaForwarder } from '${SETTLE}';
          import { checkHostedIntentSettleAdmission as admit } from '${GATE_MODULE}';
          export async function pay(input: never) {
            if ((await admit(input)) !== 'allow') return null;
            return settleViaForwarder(input);
          }`,
        [ROUTE]: `import { pay } from '@/lib/fenceFixture/pay';
          export const POST = (input: never) => pay(input);`,
      },
      { 'lib/fenceFixture/pay.ts#pay -> settleViaForwarder': 'gated' },
    ],
    [
      'ゲートを import しただけ・出口の後で呼ぶ・別の関数で呼ぶ',
      {
        'app/api/fence-fixture/unused/route.ts': `import { settleViaForwarder } from '${SETTLE}';
          import { checkHostedIntentSettleAdmission } from '${GATE_MODULE}';
          export const POST = (input: never) => [checkHostedIntentSettleAdmission, settleViaForwarder(input)];`,
        'app/api/fence-fixture/after/route.ts': `import { settleViaForwarder } from '${SETTLE}';
          import { checkHostedIntentSettleAdmission } from '${GATE_MODULE}';
          export async function POST(input: never) {
            const result = await settleViaForwarder(input);
            await checkHostedIntentSettleAdmission(input);
            return result;
          }`,
        'app/api/fence-fixture/elsewhere/route.ts': `import { settleViaForwarder } from '${SETTLE}';
          import { checkHostedIntentSettleAdmission } from '${GATE_MODULE}';
          export const admit = (input: never) => checkHostedIntentSettleAdmission(input);
          export const POST = (input: never) => settleViaForwarder(input);`,
      },
      {
        'app/api/fence-fixture/unused/route.ts#POST -> settleViaForwarder': 'ungated',
        'app/api/fence-fixture/after/route.ts#POST -> settleViaForwarder': 'ungated',
        'app/api/fence-fixture/elsewhere/route.ts#POST -> settleViaForwarder': 'ungated',
      },
    ],
    [
      'settleViaForwarder を飛ばして下の層を直接組み立てる',
      {
        [ROUTE]: `import { selfHostIoFor } from '${PROVIDER}';
          import { submitSelfHost } from '@/lib/relay/selfHostRelayer';
          export const POST = (target: never, data: never) => submitSelfHost(selfHostIoFor(137), target, data);`,
      },
      { [`${ROUTE}#POST -> selfHostIoFor`]: 'raw', [`${ROUTE}#POST -> submitSelfHost`]: 'raw' },
    ],
    [
      'module の初期化コードで登録して、名前でなく表から呼ぶ',
      {
        'lib/fenceFixture/registry.ts': `import { settleViaForwarder } from '${SETTLE}';
          export const handlers: Record<string, unknown> = {};
          handlers.settle = settleViaForwarder;`,
        [ROUTE]: `import { handlers } from '@/lib/fenceFixture/registry';
          export const POST = (kind: string) => handlers[kind];`,
      },
      { 'lib/fenceFixture/registry.ts#<init> -> settleViaForwarder': 'ungated' },
    ],
    [
      '出口と同じ file の、出口でない export と型だけを使う (数えない)',
      {
        [ROUTE]: `import { feeReceiverFor } from '${SETTLE}';
          import type { settleViaForwarder } from '${SETTLE}';
          import { PROVIDER, SUPPORTED_CHAINS } from '${PROVIDER}';
          export type Settle = typeof settleViaForwarder;
          export const GET = () => [feeReceiverFor(137), PROVIDER, SUPPORTED_CHAINS];`,
      },
      {},
    ],
    [
      'import した module の初期化で出口を呼ぶ (変数の初期化式・初期化で呼ぶ関数への callback・class の static)',
      {
        'lib/fenceFixture/initVar.ts': `import { settleViaForwarder } from '${SETTLE}';
          export const work = settleViaForwarder({} as never);`,
        'lib/fenceFixture/initCallback.ts': `import { settleViaForwarder } from '${SETTLE}';
          export const later = Promise.resolve().then(() => settleViaForwarder({} as never));`,
        'lib/fenceFixture/initStatic.ts': `import { settleViaForwarder } from '${SETTLE}';
          class Boot { static started = settleViaForwarder({} as never); }`,
        'lib/fenceFixture/initBlock.ts': `import { settleViaForwarder } from '${SETTLE}';
          export class Boot { static { void settleViaForwarder({} as never); } }`,
        [ROUTE]: `import '@/lib/fenceFixture/initVar';
          import '@/lib/fenceFixture/initCallback';
          import '@/lib/fenceFixture/initStatic';
          import '@/lib/fenceFixture/initBlock';
          export const GET = () => null;`,
      },
      {
        'lib/fenceFixture/initVar.ts#<init> -> settleViaForwarder': 'ungated',
        'lib/fenceFixture/initCallback.ts#<init> -> settleViaForwarder': 'ungated',
        'lib/fenceFixture/initStatic.ts#<init> -> settleViaForwarder': 'ungated',
        'lib/fenceFixture/initBlock.ts#<init> -> settleViaForwarder': 'ungated',
      },
    ],
    [
      '名前が参照されるまで走らない関数 (変数に入れた関数・class の method と instance の property) は、使わなければ数えない',
      {
        'lib/fenceFixture/stored.ts': `import { settleViaForwarder } from '${SETTLE}';
          export const pay = (input: never) => settleViaForwarder(input);
          export class Payer {
            run = () => settleViaForwarder({} as never);
            pay(input: never) { return settleViaForwarder(input); }
          }`,
        [ROUTE]: `import '@/lib/fenceFixture/stored';
          export const GET = () => null;`,
      },
      {},
    ],
    [
      'ゲートと同じ名前の局所の関数・引数を先に呼ぶ (ゲートとみなさない)',
      {
        'app/api/fence-fixture/local/route.ts': `import { settleViaForwarder } from '${SETTLE}';
          import { checkHostedIntentSettleAdmission } from '${GATE_MODULE}';
          export async function POST(input: never) {
            async function checkHostedIntentSettleAdmission(_: never) { return 'allow'; }
            if ((await checkHostedIntentSettleAdmission(input)) !== 'allow') return null;
            return settleViaForwarder(input);
          }`,
        'app/api/fence-fixture/param/route.ts': `import { settleViaForwarder } from '${SETTLE}';
          import { checkHostedIntentSettleAdmission } from '${GATE_MODULE}';
          export async function POST(input: never, checkHostedIntentSettleAdmission = async (_: never) => 'allow') {
            if ((await checkHostedIntentSettleAdmission(input)) !== 'allow') return null;
            return settleViaForwarder(input);
          }`,
      },
      {
        'app/api/fence-fixture/local/route.ts#POST -> settleViaForwarder': 'ungated',
        'app/api/fence-fixture/param/route.ts#POST -> settleViaForwarder': 'ungated',
      },
    ],
  ])('%s', (_title, files, expected) => {
    expect(verdicts(files)).toEqual(expected);
  });

  it('たどれない書き方は落とす', () => {
    expect(() => verdicts({ [ROUTE]: 'export const POST = (path: string) => import(path);' })).toThrow(/non-literal/);
    expect(() => verdicts({ [ROUTE]: "import { pay } from '@/lib/fenceFixture/missing';\nexport const POST = pay;" }))
      .toThrow(/unresolved import/);
    expect(() => verdicts({ [ROUTE]: `import { settleViaForwarder2 } from '${SETTLE}';\nexport const POST = settleViaForwarder2;` }))
      .toThrow(/unresolved export settleViaForwarder2/);
    // 初期化で static method を this で呼ぶ・初期化の中の object の getter を読む (どちらも走る先を名前でたどれない)。
    const boot = (body: string) => ({
      'lib/fenceFixture/boot.ts': `import { settleViaForwarder } from '${SETTLE}';\n${body}`,
      [ROUTE]: "import '@/lib/fenceFixture/boot';\nexport const GET = () => null;",
    });
    expect(() => verdicts(boot('class Boot { static run() { return settleViaForwarder({} as never); } static { this.run(); } }')))
      .toThrow(/module の初期化の this/);
    expect(() => verdicts(boot('export const value = { get run() { return settleViaForwarder({} as never); } }.run;')))
      .toThrow(/module の初期化の object の getter/);
  });

  // broadcast の primitive は宣言の単位で数える。route が使わない宣言も、読み込まれる file にあれば数える。
  it.each<[string, Record<string, string>, string[]]>([
    [
      'IO を取り出して sendRawTransaction を直接呼ぶ',
      {
        [ROUTE]: `import { selfHostIoFor } from '${PROVIDER}';
          export const POST = (raw: never) => selfHostIoFor(137).sendRawTransaction(raw);`,
      },
      [`${ROUTE}#POST`],
    ],
    [
      '送信の関数を足した file は、宣言を 1 つずつ数える (route が使わない宣言も)',
      {
        'lib/fenceFixture/sender.ts': `export const PROVIDER = 'self-host';
          export const send = (wallet: never) => wallet.sendTransaction({});
          export function sendLater(client: never) { return client.writeContract({}); }`,
        [ROUTE]: `import { PROVIDER } from '@/lib/fenceFixture/sender';
          export const GET = () => PROVIDER;`,
      },
      ['lib/fenceFixture/sender.ts#send', 'lib/fenceFixture/sender.ts#sendLater'],
    ],
    [
      'primitive の別名 import (呼ぶ・.call で呼ぶ)',
      {
        [ROUTE]: `import { sendTransaction as broadcast } from 'viem/actions';
          export const POST = (wallet: never, tx: never) => broadcast(wallet, tx);
          export const PUT = (wallet: never, tx: never) => broadcast.call(null, wallet, tx);`,
      },
      [`${ROUTE}#POST`, `${ROUTE}#PUT`],
    ],
    [
      '文字列の computed 呼び出し',
      { [ROUTE]: "export const POST = (wallet: never) => wallet['sendTransaction']({});" },
      [`${ROUTE}#POST`],
    ],
    [
      '生の RPC の送信の method 名',
      {
        [ROUTE]: `export const POST = (client: never, raw: never) =>
            client.request({ method: 'eth_sendRawTransaction', params: [raw] });
          export const PUT = (client: never, op: never) => client.request({ method: 'eth_sendUserOperation', params: [op] });`,
      },
      [`${ROUTE}#POST`, `${ROUTE}#PUT`],
    ],
    [
      'viem の getContract の write (`.write.<名前>` と `.write[…]`)',
      {
        [ROUTE]: `import { getContract } from 'viem';
          export const POST = (client: never, args: never) => getContract(client).write.settle(args);
          export const PUT = (contract: never, args: never) => contract.write['settle'](args);`,
      },
      [`${ROUTE}#POST`, `${ROUTE}#PUT`],
    ],
    [
      'primitive を名前を変えて再 export した file (使う側の名前では見つからない)',
      {
        'lib/fenceFixture/actions.ts': "export { sendTransaction as broadcast } from 'viem/actions';",
        [ROUTE]: `import { broadcast } from '@/lib/fenceFixture/actions';
          export const POST = (wallet: never, tx: never) => broadcast(wallet, tx);`,
      },
      ['lib/fenceFixture/actions.ts#<init>'],
    ],
  ])('broadcast の primitive: %s', (_title, files, expected) => {
    const decls = analyze(Object.keys(files).filter((file) => file.startsWith('app/')), files).primitiveDecls;
    expect(decls.filter((decl) => decl.slice(0, decl.lastIndexOf('#')) in files)).toEqual(expected);
  });
});
