// Agent の見た目 (名前・色・アイコン)。利用者が自分で選んだものだけを端末に保存する
// (サーバーへ送らない・アドレスから Wallet の種類を推測しない)。
// クラスは Tailwind の JIT が拾えるよう完全な文字列で持つ (tailwind.config の content は lib/ を含む)。

export const AGENT_COLORS = ['ink', 'indigo', 'emerald', 'amber', 'rose', 'violet'] as const;
export type AgentColor = (typeof AGENT_COLORS)[number];

// 残高の面。どれも白文字で AA を満たす暗さ (明るい側 = *-800 でも白との比 7:1 以上)。
export const AGENT_COLOR_SURFACE: Record<AgentColor, string> = {
  ink: 'bg-gradient-to-br from-slate-900 to-slate-800',
  indigo: 'bg-gradient-to-br from-indigo-950 to-indigo-800',
  emerald: 'bg-gradient-to-br from-emerald-950 to-emerald-800',
  amber: 'bg-gradient-to-br from-amber-950 to-amber-800',
  rose: 'bg-gradient-to-br from-rose-950 to-rose-800',
  violet: 'bg-gradient-to-br from-violet-950 to-violet-800',
};

export const AGENT_COLOR_DOT: Record<AgentColor, string> = {
  ink: 'bg-slate-800',
  indigo: 'bg-indigo-700',
  emerald: 'bg-emerald-700',
  amber: 'bg-amber-700',
  rose: 'bg-rose-700',
  violet: 'bg-violet-700',
};

export const AGENT_ICONS = ['🤖', '🦊', '🐙', '🦉', '🐳', '🐱', '🌸', '🍀', '⚡', '🔮', '🚀', '🎯'] as const;
export type AgentIcon = (typeof AGENT_ICONS)[number];

export function isAgentColor(value: unknown): value is AgentColor {
  return typeof value === 'string' && (AGENT_COLORS as readonly string[]).includes(value);
}

export function isAgentIcon(value: unknown): value is AgentIcon {
  return typeof value === 'string' && (AGENT_ICONS as readonly string[]).includes(value);
}

// アイコン未設定のときの丸。アドレスの先頭から 2 つの色相を作るだけの見分け用で、種類や所有の推測には使わない。
export function addressHues(address: string): readonly [number, number] {
  const hex = address.slice(2).toLowerCase();
  const hue = (from: number) => (Number.parseInt(hex.slice(from, from + 4), 16) || 0) % 360;
  return [hue(0), hue(4)];
}
