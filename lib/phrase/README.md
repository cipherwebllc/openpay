# lib/phrase — 日本語の文を文節で区切る

iPhone の Safari (WebKit) と Firefox は、文節で折る CSS (`word-break: auto-phrase`) を持たず、日本語を字の間のどこでも折る。
server が文節の区切りを計算し、`components/Phrased.tsx` が区切りに `<wbr>` を入れて渡す。折り方の指定は `app/globals.css` の `.phrased`。

npm の依存は足していない。BudouX の日本語の model (JSON 1 つ) と、parser を書き直した小さな code をここに置く。

## 出どころ

| file | 出どころ | 変更 |
|---|---|---|
| `budoux-ja.json` | [google/budoux](https://github.com/google/budoux) の `budoux/models/ja.json`・tag `v0.10.3` | なし (1 byte も変えていない) |
| `LICENSE` | 同じ tag の `LICENSE` (Apache-2.0 の全文) | なし |
| `phrases.ts` | 同じ tag の `javascript/src/parser.ts` を書き直したもの (Copyright 2021 Google LLC・Apache-2.0) | あり (下) |

- `budoux-ja.json`: 20,036 byte・sha256 `1e0ed578ad0f4ac14045e5f5fddbe263962a7f5e8fe22821da0048188aa55551`
- `LICENSE`: 11,357 byte・sha256 `58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd`
- upstream の tag `v0.10.3` に NOTICE の file は無い。

model の file は改行の無い 1 行。git が中身を変えないよう、`.gitattributes` で text の変換を外している。
大きさと sha256 は `tests/lib/phrases.test.ts` が固定する (黙って書き換えると落ちる)。

## `phrases.ts` が upstream と違う所

区切りの計算 (`createBoundaryParser`) は upstream の `Parser.parseBoundaries` と同じ式。その結果に、次の決まりを掛けてから返す (`phrasesJa`)。
どれも区切りを減らすだけで、字は 1 つも変えない (返した塊をつなぐと、元の文字列に戻る)。

1. 禁則: 開き括弧の直後と、閉じ括弧・句読点・小さいかな・長音・繰り返しの記号の直前では区切らない。
2. 割らない語 (`PHRASE_KEEP_WORDS`): 表にある語の中では区切らない。
3. 日本語の字 (ひらがな・カタカナ・漢字) を含まない文は、区切らずにそのまま返す。

upstream の HTML を書き換える部分 (`html_processor.ts`) と Web Components は持ってきていない。

## 使い方の決まり

- server だけ (`import 'server-only'`)。model を client の bundle に入れない。`'use client'` の file からたどれないことをテストが見る。
- 欄より長い塊は、塊の途中で折れる (`overflow-wrap: anywhere`)。スマホで 2 列になる狭いカードの本文・表のセルには当てない。
- 文を足したら、語の途中に区切りが出ていないかを見る。出ていたら `PHRASE_KEEP_WORDS` に語を足し、テストにその文を足す。

## model を更新するとき

1. upstream の新しい tag の `budoux/models/ja.json` と `LICENSE` を取り、この directory の 2 つを置き換える (中身は変えない)。
2. 同じ tag の `javascript/src/parser.ts` の式が変わっていないかを読み、変わっていたら `createBoundaryParser` を合わせる。
3. この README の tag・大きさ・sha256 と、`phrases.ts` の頭の tag、`tests/lib/phrases.test.ts` の大きさ・sha256 を直す。
4. model が変わると区切りが変わる。テストが固定している区切り (ヒーローの見出しと本文・割らない語の表) を読み直し、トップを WebKit で撮って、語の途中の折れが出ていないかを見る。
