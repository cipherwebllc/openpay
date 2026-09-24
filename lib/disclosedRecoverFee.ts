// 法務文書で開示済みの recover 利用料 (最低額と決済額連動率)。lib/legal.ts が再 export する。
// LP の節約シミュレーター等のクライアント部品が lib/legal (規約本文) を丸ごと bundle しないよう、
// 定数だけをこの小さなモジュールに置く (トップの First Load が +16 kB になった実測・第 6 回 E13/D5)。
export const DISCLOSED_RECOVER_FEE = {
  floorJpyc: 2,
  percentFromJulyBps: 100,
} as const;
