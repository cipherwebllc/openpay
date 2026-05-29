// Pimlico bundler 到達確認 (spike の "HTTP request failed" 原因切り分け用・使い捨て)。
// シェルのクォートを避けるため env 変数だけ渡す:
//   PIMLICO_API_KEY=<key> [CHAIN_ID=421614] node scripts/check-pimlico.mjs
//
// 結果の読み方:
//   - HTTP 200 + result に EntryPoint 配列 → キー/チェーン OK (v0.8 含むか確認)
//   - HTTP 401 / invalid key → キーが違う/未設定
//   - HTTP 404 / chain 系 → この経路で当該チェーン未対応
//   - FETCH ERROR → ネットワーク/プロキシ/瞬断 (再実行)

const key = process.env.PIMLICO_API_KEY || process.env.NEXT_PUBLIC_PIMLICO_API_KEY;
const chainId = process.env.CHAIN_ID || '421614'; // 既定 Arbitrum Sepolia
const EP08 = '0x4337084d9e255ff0702461cf8895ce9e3b5ff108'; // EntryPoint v0.8
const EP07 = '0x0000000071727de22e5e9d8baf0edac6f37da032'; // EntryPoint v0.7

if (!key) {
  console.log('❌ PIMLICO_API_KEY 未設定。PIMLICO_API_KEY=<key> を付けて再実行してください。');
  process.exit(1);
}

const url = `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${key}`;
// Origin 制限付きキーを使う場合は許可済み origin を送る: PIMLICO_ORIGIN=https://open-pay.jp
const origin = process.env.PIMLICO_ORIGIN;
console.log(`chainId: ${chainId}`);
console.log(`URL    : https://api.pimlico.io/v2/${chainId}/rpc?apikey=${key.slice(0, 6)}…(${key.length} 文字)`);
console.log(`Origin : ${origin || '(なし)'}`);

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_supportedEntryPoints', params: [] }),
  });
  console.log(`HTTP   : ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.log(`body   : ${text}`);
  const low = text.toLowerCase();
  console.log(`EntryPoint v0.8 (${EP08}) サポート: ${low.includes(EP08) ? 'YES' : 'NO'}`);
  console.log(`EntryPoint v0.7 (${EP07}) サポート: ${low.includes(EP07) ? 'YES' : 'NO'}`);
} catch (e) {
  console.log(`❌ FETCH ERROR: ${e.message}${e.cause?.message ? ` / cause: ${e.cause.message}` : ''}`);
  console.log('→ ネットワーク/プロキシ/瞬断の可能性。時間をおいて再実行を。');
}
