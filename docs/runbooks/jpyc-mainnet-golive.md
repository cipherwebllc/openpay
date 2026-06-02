# Runbook: JPYC recover を Polygon mainnet に投入する

> 対象: `Eip3009Forwarder` を Polygon (137) に deploy し、recover モードを mainnet で有効化する手順。
> 前提ドキュメント: `docs/audit/jpyc-eip3009-audit-scope.md`(監査スコープ)、`contracts/README.md`。
> **このランブックは外部監査が完了するまで実行しないこと。** 各ステップは人間が承認して実行する。

## 0. ゲート(リスク階層型)

監査の要否は **value at risk** に比例する。OpenPay は非カストディ + relayer=POL のみ + forwarder は
残高非保持(atomic receive→split)+ owner/upgrade/rescue 無しで drain 面が構造的に最小。よって:

### 0-a. アルファ(小キャップ)で出す場合のゲート — 実ファーム監査は**不要**
- [x] **内部 adversarial レビュー完了**(Codex contract+relay・全 finding CLOSED。契約 P2
      `merchant==forwarder` 修正済 = commit e2efe37)。
- [ ] **per-tx + 日次キャップを小さく**(`RELAY_MAX_JPYC` を小・`RELAY_DAILY_TX_CAP` を控えめ)。
- [ ] **alpha/未監査を明示開示**(既存 AlphaNotice + 利用規約。"外部監査未実施・少額のみ" を明記)。
- [ ] mainnet 用 deployer 鍵(Polygon POL 保有)/ relayer 鍵(POL)/ KV(本番 Upstash・testnet と別)。
- [ ] `RELAY_MAX_GAS_COST_WEI` を §5 の式で設定(未設定は mainnet self-host で 503)。
- [ ] `feeReceiver` = 本番 `NEXT_PUBLIC_FEE_RECEIVER_ADDRESS` 確定。
- [ ] 稼働後 §8 の監視を有効化。

### 0-b. 本格運用(キャップ引き上げ・本番訴求・パートナー/規制要件)に進む前
- [ ] **実ファーム監査**(Trail of Bits / OpenZeppelin / Spearbit / 国内ファーム等)を実施し指摘反映。
      LLM/Codex レビューは subtle bug を見落としうるため、守る価値が増えたら専門監査に切り替える。
- [ ] `Eip3009Forwarder.sol` が監査時点からバイト単位で不変(下記 codehash 照合)。

> 残留リスク(アルファでも認識): 発行体による JPYC proxy upgrade、キャップは off-chain enforce、
> 署名窓内での実行タイミングは relayer 任意、誤送 JPYC は回収不能(rescue 無し)。`docs/audit/...` §6。

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

## 付録: 現状(2026-06-02 時点)— アルファ投入に必要な残項目

コード面は **アルファ投入可**(内部レビュー完了・契約 P2 修正済 e2efe37・Codex 評定「小キャップ
アルファなら firm 監査なしで妥当」)。残るは ops 設定のみ:

- [ ] `DEPLOYER_PRIVATE_KEY`(Polygon POL 保有)。現状: 未設定。
- [ ] relayer の **Polygon mainnet POL**。現状: 0(deploy/relay とも払えない)。
- [ ] `NEXT_PUBLIC_JPYC_FORWARDER_POLYGON`(§3 deploy 後に設定)。
- [ ] `RELAY_MAX_GAS_COST_WEI`(§5)/ 本番 KV / `RELAY_MAX_JPYC`(小さく)。
- [ ] alpha/未監査の明示開示(AlphaNotice + 利用規約)。

→ 上記が揃えば §1〜§7 を順に実行して**アルファとして本番 gasless を稼働**できる。
本格運用(キャップ引き上げ)前に §0-b の実ファーム監査。
