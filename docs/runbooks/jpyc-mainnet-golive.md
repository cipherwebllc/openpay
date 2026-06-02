# Runbook: JPYC recover を Polygon mainnet に投入する

> 対象: `Eip3009Forwarder` を Polygon (137) に deploy し、recover モードを mainnet で有効化する手順。
> 前提ドキュメント: `docs/audit/jpyc-eip3009-audit-scope.md`(監査スコープ)、`contracts/README.md`。
> **このランブックは外部監査が完了するまで実行しないこと。** 各ステップは人間が承認して実行する。

## 0. ハードゲート(すべて満たすまで deploy しない)

- [ ] **外部セキュリティ監査が完了**し、指摘(あれば)を反映済(再監査 or 監査人の確認済)。
      ※ 実マネーを扱う契約。LLM/Codex レビュー(実施済・全 CLOSED)は**監査の代替ではない**。
- [ ] `Eip3009Forwarder.sol` が監査時点からバイト単位で不変(下記 codehash 照合)。
- [ ] mainnet 用の **deployer 鍵**(Polygon POL を保有・relayer 鍵とは別推奨)を用意。
- [ ] mainnet 用 **relayer 鍵**(POL 保有)と **KV(本番 Upstash・testnet とは別 DB)** を用意。
- [ ] `RELAY_MAX_GAS_COST_WEI` を後述の式で算出し設定(未設定だと mainnet self-host は 503 で拒否)。
- [ ] `feeReceiver` mainnet アドレス確定(= 本番 `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` と一致必須)。

## 1. ビルド再現性の確認(監査と同一バイトコード)

```bash
cd contracts のあるリポジトリ root
~/.foundry/bin/forge --version          # forge 1.7.x
# 依存を監査と同一タグで pin (OZ v5.6.1 / forge-std v1.10.0)
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 foundry-rs/forge-std@v1.10.0 --no-git
forge clean && forge build              # solc 0.8.28 / optimizer 200 (foundry.toml)
forge test                              # 14 unit 全 pass を確認
```

監査人が照合した creation/runtime bytecode と一致することを確認(監査レポートの codehash と突き合わせ)。

## 2. deploy 直前チェック

```bash
# deployer の Polygon POL 残高 (deploy gas ~0.05 POL 目安、余裕を見て >=0.2)
cast balance <DEPLOYER_ADDR> --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL" --ether
# JPYC mainnet アドレスが正しいか (全 chain 同一: 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29)
cast call 0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 "symbol()(string)" --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL"
# → "JPYC" を確認
```

## 3. deploy(Polygon mainnet)

```bash
DEPLOY_JPYC=0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29 \
DEPLOY_FEE_RECEIVER=<本番 feeReceiver = NEXT_PUBLIC_FEE_RECEIVER_ADDRESS> \
forge script contracts/script/DeployForwarder.s.sol:DeployForwarder \
  --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL" \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --broadcast --verify --etherscan-api-key "$POLYGONSCAN_API_KEY"
```

- `--verify` で Polygonscan 検証まで行う(監査透明性のため必須)。
- 出力された forwarder アドレスを控える(= `FORWARDER_POLYGON`)。

## 4. on-chain 検証(設定前に必ず)

```bash
cast code <FORWARDER_POLYGON> --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL" | head -c 8   # 0x + bytecode あり
cast call <FORWARDER_POLYGON> "token()(address)"       --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL"  # == JPYC
cast call <FORWARDER_POLYGON> "feeReceiver()(address)"  --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL"  # == 本番 feeReceiver
cast call <FORWARDER_POLYGON> "COMMIT_VERSION()(bytes32)" --rpc-url "$NEXT_PUBLIC_POLYGON_RPC_URL"
# == keccak256("openpay.eip3009.forwarder.v1") = 0x... (forwarderIntent.ts と一致)
```

`feeReceiver` が本番 `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` と**一致しないと署名検証が通らない**。不一致なら
deploy しなおし(immutable のため変更不可)。

## 5. RELAY_MAX_GAS_COST_WEI の算出(B5・赤字防止)

回収する固定 fee(`NEXT_PUBLIC_RELAY_GAS_FEE_JPYC`・既定 2 JPYC)を超えない native コスト上限を設定する。

- settle のガス実測 ≈ 250–300k gas(Amoy fork 実測)。
- 許容 gasPrice 上限 = (回収 fee を JPYC→POL 換算した値) / gas。
- 保守的には worst-case の Polygon gasPrice(混雑時)× 300k を JPYC 換算し、回収 fee を超える分は relay
  しない(顧客は standard で自分の gas を払う)値に設定。
- 例(要・実値で再計算): `RELAY_MAX_GAS_COST_WEI=` (例 0.05 POL = `50000000000000000`)。
  → 運用開始後、実 gas と POL/JPY レートを見て調整。**未設定は 503 で安全側(deploy 直後の事故防止)**。

## 6. 本番環境変数の設定(Vercel 等)

```
NEXT_PUBLIC_JPYC_FORWARDER_POLYGON=<FORWARDER_POLYGON>
RELAYER_PRIVATE_KEY=<本番 relayer・POL 保有>           # server only
KV_REST_API_URL / KV_REST_API_TOKEN=<本番 Upstash>     # mainnet 必須
RELAY_MAX_GAS_COST_WEI=<§5 で算出>
RELAY_MAX_JPYC=<初期は小さく・例 5000 から段階引き上げ>
NEXT_PUBLIC_RELAY_GAS_FEE_JPYC=<2 等>
```

- `RELAYER_PRIVATE_KEY` があると PROVIDER=self-host。Polygon + forwarder 設定で recover モードになる。
- **mainnet self-host は KV 未設定だと 503 kv_required・RELAY_MAX_GAS_COST_WEI=0 だと 503 gas_ceiling_required**
  (route のガード)。両方設定されて初めて稼働する。
- デプロイ後、`/api/relay/jpyc` に空 POST → 400(配線確認)。

## 7. 本番 smoke(小額・実 JPYC)

- 小額(例 merchant 10 + fee 2 JPYC)の recover 決済を 1 件 実行 → settle 成功・feeReceiver に fee 着金・
  merchant に着金を Polygonscan で確認。
- 同一 authorization の重複 POST → 1 件成立 / もう 1 件 pending(B2)。
- relayer POL が想定どおり減る(立替)。
- `RELAY_MAX_JPYC` を超える額 → reject される。

## 8. 監視(稼働後・継続)

- relayer POL 残高(枯渇前にアラート・立替が回るので残高が落ち続けるのは異常)。
- `relay:budget:{137}:{YYYYMMDD}` の日次件数(Sybil/異常スパイク検知)。
- pending 率(receipt timeout / collision の頻度。高ければ単一 relayer の throughput 限界 → queue 化検討)。
- feeReceiver の JPYC 入金 vs relayer の POL 流出(回収が立替を賄えているかの損益分岐)。

## 9. ロールバック / 緊急停止

- **recover を即時無効化**: 本番環境変数の `NEXT_PUBLIC_JPYC_FORWARDER_POLYGON` を空に → 次デプロイ/再起動で
  free/standard に fallback(contract は undeploy できないが、アプリが使わなければ無害)。
- **relayer 全停止**: `RELAYER_PRIVATE_KEY` を外す → PROVIDER=null → `/api/relay/jpyc` が 503。client は
  standard モードに案内(顧客が自分で gas を払う)。
- **鍵漏洩時**: relayer 鍵をローテーション + 残 POL 退避。**顧客 JPYC は署名束縛で安全**(forwarder の
  再 deploy 不要)。
- forwarder 自体に異常(監査見落とし)が見つかった場合: env を空にして使用停止 → 新 forwarder を deploy し
  アドレス差し替え(immutable なので修正は新 deploy)。

## 10. 段階的ロールアウト

1. `RELAY_MAX_JPYC` を小さく(例 5,000)始め、数日 無事故を確認。
2. 監視指標(pending 率・POL 流出・回収差益)が健全なら段階的に引き上げ。
3. 高 volume で pending 率が上がるなら、単一 relayer の nonce queue 化 / マルチ relayer を検討
   (`docs/audit/jpyc-eip3009-audit-scope.md` §6-1 の既知制約)。

---

## 付録: 現状(2026-06-02 時点)の未充足項目

- 外部監査: 未実施(本ランブック §0 のハードゲート)。
- `DEPLOYER_PRIVATE_KEY`: 未設定。relayer の Polygon mainnet POL: 0。
- `NEXT_PUBLIC_JPYC_FORWARDER_POLYGON` / `RELAY_MAX_GAS_COST_WEI`: 未設定。
- → 上記が揃い、監査が完了するまで §3 以降は実行しない。
