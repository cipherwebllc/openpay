// x402 の 1 JPYC デモ (first-party) の path。登録表 (lib/x402/firstParty.ts) と、AI ストアの
// 「2円で試す」節・カタログからの除外 (components/x402/) が共有する。client からも import するので依存を持たない。
export const X402_DEMO_PATH = '/api/paid/demo';
