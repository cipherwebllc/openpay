# contracts/ — JPYC ガス回収 forwarder (Foundry)

JPYC ガスレス決済 (OpenPay) の **ガス相当額回収用 forwarder** コントラクト。設計・背景は
`docs/plans/jpyc-relay-gas-recovery.md` と memory:jpyc-eip3009 / memory:gasless-legal-jp。

- `src/Eip3009Forwarder.sol` — 顧客 1 署名 (EIP-3009 `receiveWithAuthorization`) で JPYC を受領し、
  店舗 + feeReceiver にアトミック分割。relayer が POL 立替 → gas 相当額を JPYC 即時回収。

レイアウト: `contracts/src/` (本体) ・ `contracts/test/` ・ `contracts/lib/` (forge deps・gitignore)。
src と lib を同階層に分けている (lib を src 内に置くと依存まで src 扱いで壊れるため)。

> Next.js アプリと同居するため Foundry の全 dir を `contracts/` 配下に隔離している
> (`foundry.toml` 参照)。リポジトリの `lib/` は TypeScript で、Foundry deps は `contracts/lib/`。

## セットアップ

```bash
# 1. Foundry (forge/cast/anvil)
curl -L https://foundry.paradigm.xyz | bash && foundryup

# 2. 依存を contracts/lib/ に install (監査再現性のためタグ pin)
#    OZ v5.6.1 (SafeERC20/ReentrancyGuard は deploy 契約に含む = 監査対象) / forge-std v1.10.0 (test 専用)
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 foundry-rs/forge-std@v1.10.0 --no-git

# 3. ビルド & テスト
forge build
forge test -vvv
```

## Amoy への deploy (検証用・監査不要)

```bash
forge create contracts/src/Eip3009Forwarder.sol:Eip3009Forwarder \
  --rpc-url "$NEXT_PUBLIC_POLYGON_AMOY_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --constructor-args 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 "$FEE_RECEIVER_ADDRESS"
```

> mainnet 投入は **外部セキュリティ監査** が前提。Phase B 堅牢化 (B1–B5: idempotency /
> ambiguous-send pre-sign / 日次予算 / gas ceiling) は実装済 + Codex review 全 finding CLOSED +
> Amoy 実環境検証済。監査スコープ・不変条件・脅威モデルは `docs/audit/jpyc-eip3009-audit-scope.md`。
> Amoy (testnet) は監査不要でフロー検証可。

## 実環境検証ハーネス (Amoy)

relay サーバ + forwarder を **実 chain (Amoy)** で検証するスクリプト群 (`scripts/`)。いずれも
`.env.local` を読み、署名前に golden vector で nonce/encode が契約と一致することを fence する。
機密は出力しない (秘密鍵は address のみ導出)。

**前提**: `.env.local` に `RELAYER_PRIVATE_KEY` (POL 保有・self-host relayer) /
`NEXT_PUBLIC_JPYC_FORWARDER_AMOY` / `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` /
`NEXT_PUBLIC_POLYGON_AMOY_RPC_URL`。並行/idempotency テストは追加で `AMOY_TEST_BUYER_KEY`
(JPYC 保有の署名元・使い捨て testnet 鍵) と、KV 検証時は `KV_REST_API_URL` / `KV_REST_API_TOKEN`。
relay endpoint を動かすため別ターミナルで dev server (`npm run dev`) を起動しておく。

```bash
# 1. 前提チェック (読み取り専用): relayer POL / forwarder・JPYC 存在 / KV 到達性 / buyer JPYC 残高
node scripts/amoy-relay-readiness.mjs [buyerAddress]

# 2. 並行 submit (B3 nonce 衝突吸収): 単一 buyer が N 個の DISTINCT authorization を同時 POST →
#    単一 relayer EOA の nonce 競合を誘発。on-chain で照合 (txHash distinct / settle 件数 /
#    nonce 連続=hole なし / feeReceiver・buyer 差分)。
RELAY_URL=http://localhost:3000/api/relay/jpyc N=6 node scripts/amoy-concurrent-settle.mjs

# 3. idempotency (B2): 同一 authorization を 2 回同時 POST → 1 件 success / 1 件 pending
#    (submit 前に弾く=revert/二重 broadcast なし)。on-chain settle 1 回のみ + KV idem key claim を確認。
#    確定後の再 POST が authState 既使用で pending になることも確認。要 KV (未設定だと fail-open で B2 無効)。
RELAY_URL=http://localhost:3000/api/relay/jpyc node scripts/amoy-idempotency.mjs
```

> 注: 重いテスト (60s 級の receipt 待ちが並行) とアプリ動作確認を同じ dev server で同時にやると
> 単一プロセスが飽和する。テストは別ポート (`PORT=3001 npm run dev`) 推奨。
> buyer の使い捨て鍵 / KV は **testnet 専用**にし、mainnet の鍵・KV とは必ず分ける。

実測結果 (2026-06-02): 並行 submit = nonce 衝突を安全吸収 (settle は連続 nonce・未 broadcast 分は
保守的 pending)・idempotency = duplicate を submit 前に弾く・いずれも二重支払いゼロ。詳細は
`docs/audit/jpyc-eip3009-audit-scope.md` §7。

## Deployed addresses

| chain | Eip3009Forwarder | feeReceiver | 備考 |
|---|---|---|---|
| Polygon Amoy (80002) | `0x752B7AaD0089286EB7b553d84D05233d80c9FCB4` | `0x428483FbA62eDCef1E3a100d3799F6d71759c560` | 検証用 (2026-06-02 deploy・未監査) |
| Polygon (137) | `0x0F4560a777415580F0680F8B56a79B0022C6B848` | `0x428483FbA62eDCef1E3a100d3799F6d71759c560` | **alpha 投入 (2026-06-02 deploy・未 firm 監査)**。COMMIT_VERSION on-chain 照合済。本格運用前に firm 監査 (runbook §0-b) |

設定: `NEXT_PUBLIC_JPYC_FORWARDER_AMOY` に上記アドレスを入れると Amoy が recover モードになる。
feeReceiver は `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` と一致必須 (一致しないと署名検証が通らない)。

## 利用ライセンス NFT — OpenPayLicense1155 (PR A)

`src/OpenPayLicense1155.sol` は Store 商品の利用ライセンスを ERC-1155 で証明する。
商品ごとに lifetime 発行上限 (1〜10,000 枚)・譲渡可否・`definitionHash` を登録し、確認済み決済
1 件につき `mintFor` で 1 枚を発行する。JPYC の受領/送金は行わず、利用回数や利用残高も持たない。
PR A はコントラクトと純粋な ID helper のみ。サーバ組込み・販売の有効化は PR B〜D と Amoy E2E 後。

### 役割・鍵の分離

- `LICENSE_OWNER`: コールド管理アドレス。`Ownable2Step` の移転先が `acceptOwnership()` して初めて
  owner が変わる。`setMinter` による交代/停止と、登録済み商品の `setURI` による修復を担当する。
  `renounceOwnership` は revert (修復権限を残す)。owner と minter の同一アドレスは、constructor・
  `setMinter`・所有権の acceptance 時に拒否する。deployer は owner と別でもよい。
- `LICENSE_MINTER`: 登録/mint を行う単一アドレス。`LICENSE_MINTER_PRIVATE_KEY` から導出する hot EOA
  を指定する。`setMinter(address(0))` で登録/mint を停止でき、ゼロでの初期 deploy も可。
  停止は既発行の balance・transfer/burn・消費記録を消さない。
- `LICENSE_MINTER_PRIVATE_KEY`: PR B の server-only worker 用秘密鍵。コールド owner の鍵と分離し、
  **`RELAYER_PRIVATE_KEY` とも別 EOA** にする。settle と register/mint が同じ EOA nonce を取り合い、
  相互に tx を置換/停滞させることを避けるため。mint worker 側の送信も直列化が必要 (PR B)。
  minter の POL は個別に入金し、testnet / mainnet の鍵も分ける。

`registerLicense` は同一 id・同一 `definitionHash` なら no-op。異なる hash は `DefinitionMismatch`。
hash 一致時は引数を再適用せず、修復済み URI も保持する。hash と登録引数の対応は minter が検証する。
上限・譲渡可否・定義 hash は登録後不変 (`reduceMaxSupply` なし)。譲渡不可商品は自己送信・0 量・
batch 混在・approval/operator 経由でも送信不可。`burn(id, amount)` / `burnBatch(ids, amounts)` は
呼出元自身の保有分だけを破棄し、lifetime の `minted` / `consumed` を戻さない。

**残余リスク**: minter が侵害されると、登録済み商品の上限内で偽 mint が可能。さらに minter は
新しい id の登録も可能なので、10,000 は商品ごとの上限であり、全商品の総被害上限ではない。
minter の交代/停止は既発行の偽 mint を取り消さない。NFT 単体は独立した決済証明ではなく、
minter による決済証拠確認を信頼する。連携先は信頼する chain + contract + tokenId を固定する。

### ABI / golden vector (PR B との境界)

```text
PAYMENT_KEY_V1 = keccak256("openpay.license.payment.v1")
paymentKey = keccak256(abi.encode(
  PAYMENT_KEY_V1, uint256(paymentChainId), address(paymentToken), address(payer), bytes32(authorizationNonce)
))
tokenId = uint256(keccak256(abi.encodePacked("openpay:license:", productIdString)))
```

`paymentChainId` は決済元 chain。txHash は決済証拠/既存 KV の冪等鍵として別に保持し、paymentKey に
NFT chain・contract・商品 id を加えない。1 authorization を別商品へ二重発行することを防ぐ。
`paymentKeyOf(key)` は `MintRecord { uint256 id; address to; }` を返し、`to == address(0)` が未消費。
id=0 / key=0 も有効なので id だけで判定しない。消費済み key の retry は `PaymentKeyConsumed` となり、
PR B は記録の id/to とイベントを照合して復旧する。

`productIdString` は `lib/x402/hostedStore.ts` の `newHostedId()` が生成する **`h_` + 小文字 hex 32 桁**
(ランダム 128 bit)。`h_` を含めて UTF-8 文字列のまま hash し、hex decode・prefix 除去・大小文字変換を
しない。固定 prefix と可変長文字列 1 個なので packed の境界は一意。衝突/誤再利用は定義 hash の不一致で
検出する。`computeTokenId(string)` は pure・形式検証なし。TS の
`lib/license/paymentKey.ts` は `computeLicensePaymentKey` (Hex) / `computeLicenseTokenId` (bigint) を提供し、
chainId 入力も bigint で扱う。tokenId を JS number に変換しない。

`contracts/test/OpenPayLicense1155.t.sol` と `tests/lib/license/paymentKey.test.ts` に同じ固定期待 hash を置く。
Polygon / Amoy・uint256 精度・商品文字列を fence する。`mintFor` は consumed/minted を先に更新し、
OZ が balance を更新してから receiver callback を呼ぶ。callback 中の同一 key 再発行・上限超過・
burn での枠復活は不可で、受取拒否はネストした操作も含め全 revert。別 key の再入 mint も onlyMinter と
上限に従うため ReentrancyGuard は不要 (権限あり/なし receiver のテストで固定)。

### Amoy → Polygon の deploy

既存の solc 0.8.28 / vendored OZ 5.6.1 と root `foundry.toml` を使用する。リポ root で実行する。
`LICENSE_OWNER` / `LICENSE_MINTER` はアドレスであり秘密鍵ではない。`DEPLOYER_PRIVATE_KEY` は deploy 用。
以下は user が deploy を承認して実行する手順 (PR A では broadcast しない)。

```bash
forge build
forge test -vv

# 1. Amoy (80002): testnet 専用の LICENSE_OWNER / LICENSE_MINTER / deployer を設定して実行
forge script contracts/script/DeployLicense.s.sol:DeployLicense \
  --rpc-url "$NEXT_PUBLIC_POLYGON_AMOY_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
# 出力された契約 address → NEXT_PUBLIC_LICENSE_NFT_AMOY

# 2. A〜D の Amoy E2E・人間レビュー・mainnet 投入承認後。
#    Polygon 用の LICENSE_OWNER / LICENSE_MINTER / deployer に切り替えて実行
forge script contracts/script/DeployLicense.s.sol:DeployLicense \
  --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" --broadcast
# 出力された契約 address → NEXT_PUBLIC_LICENSE_NFT_POLYGON
```

`LICENSE_OWNER` と `LICENSE_MINTER` を環境に設定してから実行する (script が `vm.envAddress` で読む)。
アプリの `NEXT_PUBLIC_LICENSE_NFT_POLYGON` / `NEXT_PUBLIC_LICENSE_NFT_AMOY` と
`LICENSE_MINTER_PRIVATE_KEY` は PR B の env 読み取り導入時に `.env.local.example` / root README の
env テーブルへ同時追加する。PR A ではアプリの env 読み取り・設定変更・flag 点灯を行わない。
deploy 後は owner/minter/chain を照合し、minter へ POL を入金する。既存商品の義務は元の契約に固定し、
契約アドレスの切替で供給枠をリセットしない。

### v2: purchase=mint のアトミック化

将来は購入と mint を同一 tx で行うコントラクトを、追加の認可 minter として併用できる。
PR A の `minter` は単一アドレスなので、現時点で複数登録の機能があるわけではない。v2 では別途レビューした
認可アダプターを `setMinter(adapter)` で指定し、adapter 側で旧 worker と atomic minter の双方を認可する
方式を取れる。旧義務を drain しながら同じ ERC-1155 と consumed 記録を使い続けられる。
paymentKey は txHash に依存しないため、atomic minter も tx 実行中に同じ値を計算できる。
