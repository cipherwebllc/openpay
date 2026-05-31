// 日時の 2 桁ゼロ埋め (history timestamp / CSV filename / SuccessOverlay 時刻表示で共用)。
// lib/format.ts ではなく独立モジュールに置くのは、format.ts が viem (formatUnits 等) を
// import しており、pad だけ欲しい /pay baseline の component (SuccessOverlay 等) がそれを
// 引き込むと bundle budget (/pay 420kB) を超えるため (viem は tree-shake されきらない)。
export const pad = (n: number): string => n.toString().padStart(2, '0');
