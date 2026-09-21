export type AgentActivityDirection = 'in' | 'out';

export type AgentActivityItem = {
  // 同一 hash 内の出現順は 0 始まり。transfer 単位で識別する。
  key: string;
  hash: `0x${string}`;
  timestamp: number; // 秒 (上流 timeStamp)
  direction: AgentActivityDirection;
  counterparty: `0x${string}`;
  valueAtomic: string; // JPYC 18 桁の最小単位・10 進の整数文字列
  viaOpenPay: boolean;
};

export type AgentActivityFailure =
  | 'invalid_address'
  | 'unsupported_chain'
  | 'not_configured'
  | 'rate_limited'
  | 'busy'
  | 'upstream';

export type AgentActivityResponse =
  | {
      ok: true;
      chainId: number;
      items: AgentActivityItem[];
      rawCount: number;
      truncated: boolean;
      asOf: number;
    }
  | { ok: false; reason: AgentActivityFailure };

export const AGENT_ACTIVITY_PAGE_SIZE = 50;
