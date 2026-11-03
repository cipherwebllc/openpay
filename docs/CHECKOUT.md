# リンクひとつで決済を受け取る（/checkout）と、入金を自分で確かめる方法

`/checkout` は、URL のパラメーターだけで JPYC / USDC の支払いページを開けるリンクです。
受取ウォレットのアドレスがあれば使えます。API キー・登録・サインインは要りません
（`/checkout` に限ります。@handle のモバイル注文や Store は別です → [次の段階](#次の段階)）。

OpenPay は代金を預かりません。お客様のウォレットから受取アドレスへ、ブロックチェーン上で直接届きます。

開発をしない方は、受け取りの画面の「注文リンク」タブで、商品・送料・注文番号からこのリンクを作れます。

## 最小のリンク

```
https://open-pay.jp/ja/checkout?to=0xあなたの受取アドレス&token=jpyc&items=Coffee:1:500&order_id=A-001&success_url=https://example.com/paid
```

お客様はこのページでウォレットをつなぎ、表示された金額（例: 500 JPYC）を支払います。

## パラメーター

ここに挙げたものは、互換を保って使い続けられます。これ以外のパラメーター（`webhook`・`store_handle`・`gas`・
利用料・税・レシート・店舗端末用のもの）は OpenPay の内部用で、予告なく変わります。

| 名前 | 必須 | 内容 |
|---|---|---|
| `to` | 必須 | 受取アドレス（0x…） |
| `token` | 必須 | `jpyc` または `usdc` |
| `chain` | 任意 | 省略時は JPYC = `polygon`・USDC = `base`。JPYC は `polygon` / `kaia` / `avalanche` / `ethereum`、USDC は `base` / `arbitrum` / `optimism` / `polygon` / `ethereum` / `avalanche` / `arc` |
| `items` | 必須 | `名前:数量:単価` を `,` でつなぐ（1〜10 件・数量 1〜999・単価はトークンの小数桁以内）。名前は `encodeURIComponent` してから並べる |
| `order_id` | 任意 | あなたの注文 ID（64 文字まで・超えた分は切り捨て）。`success_url` にそのまま返す |
| `description` | 任意 | 説明文（200 文字まで） |
| `store` | 任意 | 店名（48 文字まで）。お客様の画面の頭と控えに出る表示だけの値で、受取先・金額には関わらない |
| `ship` | 任意 | `ask` のとき、支払いの後にお客様が完了画面の「注文を送る」で、お名前とお届け先を自分の LINE やメールでお店へ送る（注文リンクの「何度でも使える」リンク）。お客様の情報は OpenPay に届かない。`ask` 以外の値は無視 |
| `contact` | 任意 | `line:@ID`（LINE 公式アカウント）か `mail:アドレス`。完了画面が、注文の文を入れた状態でこの送り先を開く。形が合わない値は無視（共有とコピーだけになる） |
| `chains` | 任意 | 受け付けるチェーンを `,` でつなぐ（例: `polygon,kaia`）。2 つ以上で `chain` が無ければ、お客様が払う前にチェーンを選ぶ。そのトークン・支払い方法で使えないチェーンは無視。受取アドレス `to` は全チェーンで同じものを使うので、チェーンごとに持ち主が違うコントラクトのウォレット（Safe など）には使わない。モバイル注文・お店の端末の会計では無視 |
| `disc` | 任意 | 値引きの額（`items` の合計から引く・JPYC は 1 単位・USDC は 0.01 単位・合計より小さい）。お客様の画面に小計・値引き・お支払い額が出て、払う額は値引きの後の額になる。**形が合わない・合計以上の値はエラー画面になる**（値引きなしで多く払わせないように） |
| `mode` | 任意 | `gasless`（省略時）または `standard`。**それ以外の値はエラー画面になる**（打ち間違いで利用料が発生しないように） |
| `success_url` | 任意 | 支払い完了後に移動する先（http / https） |
| `cancel_url` | 任意 | 「中止して戻る」の移動先（http / https） |

`items` は、名前だけを `encodeURIComponent` してから組み立てると、名前に `:` や `,` があっても壊れません。

```js
const sp = new URLSearchParams({ to, token: 'jpyc', order_id: 'A-001', success_url: 'https://example.com/paid' });
sp.set('items', [{ name: 'コーヒー', qty: 1, price: '500' }].map((i) => `${encodeURIComponent(i.name)}:${i.qty}:${i.price}`).join(','));
const link = `https://open-pay.jp/ja/checkout?${sp}`;
```

`success_url` / `cancel_url` が OpenPay 以外のサイトのときは、支払いの前にお客様へその移動先を表示します。

## gasless と standard

- **gasless（省略時）**: お客様はガス代用のトークン（POL など）を持っていなくても払えます。
  JPYC では OpenPay 利用料がかかり、**店舗の受取額から差し引かれます**（お客様の支払額は表示どおり）。
  チェーンやトークンの組み合わせによっては使えず、その場合は `mode=standard` を求めるエラー画面になります。
  JPYC の Ethereum は standard だけです。
- **standard**: お客様が自分のウォレットでネットワーク手数料を払います。OpenPay 利用料はかかりません。

USDC は OpenPay 利用料がかかりません。料率と条件は [料金ページ](https://open-pay.jp/ja/pricing) が正です
（このドキュメントには数字を書いていません）。

## 支払い完了後に返るもの

`success_url` に次のクエリを付けて移動します（完了から約 3 秒後）。

| 名前 | 内容 |
|---|---|
| `tx_hash` | 取引のハッシュ。**照合の鍵はこれです**（`order_id` はブロックチェーンに載りません） |
| `order_id` | 渡した値（指定したときだけ） |
| `chain` / `token` / `mode` | 支払いに使ったチェーン・トークン・方式 |
| `block` | ブロック番号（分かるときだけ） |
| `fee_tx_hash` / `user_op_hash` | 経路によって付く補助の値 |

**この値は信用しないでください。** URL はお客様の側で書き換えられます。必ず `tx_hash` を使って、
次の手順でブロックチェーン上の入金を確かめてください。

また、**サーバー間の通知（webhook）はありません**。お客様が移動の前に画面を閉じると、`success_url` には
何も届きません（その場合の探し方は [取りこぼしたとき](#取りこぼしたとき)）。

## 入金を自分で確かめる（OpenPay を信じなくてよい手順）

OpenPay の署名レシートや Payment Attestation API も使えますが、それらは OpenPay を信じる前提です。
次の手順なら、自分で用意した RPC だけで確かめられます。

1. **取引が成功しているか**: `eth_getTransactionReceipt(tx_hash)` の `status` が成功であること。
2. **自分にいくら届いたか**: その取引のログのうち、**トークン本体のアドレスが出した** `Transfer` で、
   宛先（`to`）が自分の受取アドレスのものの `value` を合計する。
   同じ形のイベントは誰のコントラクトでも出せるので、ログの `address` がトークンのアドレスと一致するものだけを数えます。
   - JPYC v3: `0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29`（全チェーン共通・小数 18 桁）
   - USDC のアドレスと、ガスレス用の forwarder の一覧は [運用の透明性](https://open-pay.jp/ja/transparency) にあります
3. **請求額と合っているか**:
   - standard / USDC: 届いた額 = 請求額。
   - JPYC の gasless: 届く額は請求額から利用料を引いた額です。同じ取引にある **公式の forwarder が出した** `Settled` イベント
     （`Settled(from, nonce, merchant, merchantValue, feeReceiver, feeValue)`）で、`merchant` が自分・`merchantValue` が届いた額・
     `merchantValue + feeValue` が請求額であることを確かめます。
4. **確定しているか**: 「`success_url` に戻ってきた」は確定の証拠ではありません（JPYC のガスレスは 1 ブロックの確認で完了画面になります）。
   - Polygon / Ethereum: 取引のブロックが `eth_getBlockByNumber("finalized")` 以下になり、そのブロック番号のブロック hash が
     receipt の `blockHash` と同じであることを確かめる。
   - Kaia / Avalanche: すぐに確定する仕組みのチェーンです。RPC が `finalized` を受け付けない場合は、数ブロック待ってから同じように
     ブロック hash を確かめる。
5. **二重に数えない**: `chainId + tx_hash` を注文と一緒に保存し、同じ取引を 2 つの注文に使わない。
6. **RPC を 1 社に頼らない**: 大事な金額なら、2 社以上の RPC で同じ結果（同じブロック hash）になることを確かめる。

### Node.js の例（viem 2.x・Polygon の JPYC）

```js
// verify-payment.mjs — tx_hash から JPYC の入金を確かめる (OpenPay のサーバーを使わない・viem 2.x)
// 使い方: node verify-payment.mjs <RPC の URL> <tx_hash> <受取アドレス> <請求額 (JPYC)>
import { createPublicClient, http, erc20Abi, parseAbi, parseEventLogs, parseUnits, isAddressEqual } from 'viem';
import { polygon } from 'viem/chains';

const JPYC = '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29'; // JPYC v3 (全チェーン共通)
const FORWARDER = '0x0F4560a777415580F0680F8B56a79B0022C6B848'; // Polygon のガスレス用 (最新は /transparency で確認)
const SETTLED = parseAbi([
  'event Settled(address indexed from, bytes32 indexed nonce, address indexed merchant, uint256 merchantValue, address feeReceiver, uint256 feeValue)',
]);

export async function verifyJpycPayment({ rpcUrl, txHash, merchant, amountJpyc }) {
  const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') return { ok: false, reason: 'reverted' };

  // 1. JPYC 本体が出した、自分宛ての Transfer だけを数える (同じ形のイベントは誰のコントラクトでも出せる)
  const received = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
    .filter((log) => isAddressEqual(log.address, JPYC) && isAddressEqual(log.args.to, merchant))
    .reduce((sum, log) => sum + log.args.value, 0n);
  if (received === 0n) return { ok: false, reason: 'no_transfer' };

  // 2. ガスレスなら、公式の forwarder の Settled で「請求額 = 受取額 + 利用料」を確かめる
  const settled = parseEventLogs({ abi: SETTLED, logs: receipt.logs })
    .filter((log) => isAddressEqual(log.address, FORWARDER) && isAddressEqual(log.args.merchant, merchant));
  if (settled.length > 1) return { ok: false, reason: 'ambiguous' };
  if (settled.length === 1 && settled[0].args.merchantValue !== received) return { ok: false, reason: 'mismatch' };
  const billed = settled.length === 1 ? settled[0].args.merchantValue + settled[0].args.feeValue : received;
  if (billed !== parseUnits(amountJpyc, 18)) return { ok: false, reason: 'amount' };

  // 3. 確定を待つ: finalized のブロック以下で、そのブロックが今も正規のチェーンにあること
  const finalized = await client.getBlock({ blockTag: 'finalized' });
  if (receipt.blockNumber > finalized.number) return { ok: false, reason: 'not_finalized' };
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) return { ok: false, reason: 'reorged' };

  // 4. 二重計上を防ぐ鍵。注文と一緒に保存し、同じ鍵の取引を 2 つの注文に使わない
  return { ok: true, key: `${polygon.id}:${receipt.transactionHash}`, received, billed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [rpcUrl, txHash, merchant, amountJpyc] = process.argv.slice(2);
  console.log(await verifyJpycPayment({ rpcUrl, txHash, merchant, amountJpyc }));
}
```

`not_finalized` のときは、しばらく待ってからもう一度呼んでください。無料の公開 RPC は、古い取引の receipt を返さない
（アーカイブ扱いでトークンを求める）ことがあります。

### 確認の署名（`ship=ask` や `order_id` のリンクで、お客様から届いた文）

`tx_hash` は誰でも Explorer で見られるので、それだけでは「この文を送った人が払った」証明になりません。
完了画面の「注文を送る」「お店に知らせる」は、送る前に払ったウォレットで次の文に `personal_sign` で署名してもらい、
届く文の最後の行（「確認の署名: 0x…」）に入れます（お金は動きません）。

```text
OpenPay order confirmation
chain: <chain のスラッグ（例: polygon）>
shop: <to の受取アドレス（チェックサム付き）>
tx: <tx_hash（小文字）>
```

改行は `\n`、末尾に改行はありません。署名した人（EOA は ecrecover、コントラクトのウォレットは ERC-1271）が、
その取引で払った人と同じなら、払ったウォレットの持ち主が署名した文です。払った人は、受取アドレスか forwarder へ
0 より多い JPYC を送った人がちょうど 1 人で、JPYC の `AuthorizationUsed` があるなら 1 つだけでその `authorizer` が
同じ人のときに決まります。誰でも複数の支払いを 1 つの取引にまとめられるので、払った人が 1 人に決まらない取引の
署名は確かめられないものとして扱ってください。注文リンクのタブの「入金を確かめる」はこれをブラウザの中で確かめます。

署名が示すのは「払ったウォレットの持ち主が、このお店へのこの支払いについて署名した」ことだけです。文は転送できるので、
送ってきた人やお届け先が正しいことは示しません。

## 取りこぼしたとき

`order_id` はブロックチェーンに載らないので、`success_url` を受け取れなかった注文は
「受取アドレス × 金額 × 時刻」で探すことになります。

- 受取アドレスの `Transfer`（`eth_getLogs`・トークンのアドレス・`topics = [Transfer, null, 受取アドレス]`）を、注文の時刻の前後で探す。
  公開 RPC は一度に検索できるブロックの範囲が狭いことがあります。
- **組み込み専用の受取アドレスを使ってください。** レジや決済 QR など他の受け取りと同じアドレスを使うと、どの支払いか区別できません。
- 同じ金額の注文を同時に受け付けていると、どの注文の支払いか決められません。その場合は人が確かめてください。
- お客様の完了画面と、お客様のブラウザに残る電子レシートには取引のハッシュが表示されます。問い合わせのときに教えてもらうこともできます。

## 注意

- ガスレス決済の forwarder コントラクトは試験運用（alpha）の段階で、第三者の監査会社による監査はまだ受けていません。
- アドレスは、必ず [運用の透明性](https://open-pay.jp/ja/transparency) か OpenPay の公式の発表と照合してください。
- ブロックチェーンの送金は取り消せません。本番の前に少額で試してください。

## 次の段階

`@handle`（サインインして作る OpenPay のページ）を持つと、次のものも使えます。登録が要るので、上の「登録不要」には含みません。

- モバイル注文（メニュー・注文の受け付け・AI エージェントからの注文。MCP の `createOrderLink` は `/@handle?cart=` のリンクを作ります）
- OpenPay Store（デジタル商品の販売。掲載一覧は `GET /api/store/listings` で取得できます）
