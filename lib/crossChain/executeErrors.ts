// cross-chain 実行が投げる専用 error。class は **この module で 1 回だけ** 定義し、facade
// (lib/crossChain/execute.ts) と分割先の各 executor が同じ class object を共有する —
// hook / component の instanceof 判定を分割で壊さないため (R12)。宣言の本文は分割前と同一。

import type { Address, Hex } from 'viem';
import type { AcceptedQuote } from './cctp';
import type { BurnSlot } from './burnMarker';
import type { CctpResumeState } from './executeTypes';

/** 再開時に「前回 burn したか」を自動判定できなかった状態。money-path を進めずここで止め、
 *  UI が買い手に説明する (kind='wait' は時間を置いて再試行、'manual' は explorer 確認 +
 *  二段確認)。Iris timeout 等の他の失敗と UI で区別するために専用型にしている。 */
export class CrossChainBurnUnresolvedError extends Error {
  readonly kind: 'wait' | 'manual';
  readonly slot: BurnSlot;
  readonly detail: string;
  /** 決定表 (設計 §4) の行番号。Sentry で遭遇頻度を行ごとに観測する。 */
  readonly row: number;
  /** 二段確認 (allowManualReburn) で再 burn を開けてよい状態か。 */
  readonly reburnable: boolean;
  readonly sourceChainId: number;
  readonly depositor: Address;
  readonly burnTxHash?: Hex;

  constructor(args: {
    kind: 'wait' | 'manual';
    slot: BurnSlot;
    detail: string;
    row: number;
    reburnable: boolean;
    sourceChainId: number;
    depositor: Address;
    burnTxHash?: Hex;
  }) {
    super(
      `cross-chain execute: ${args.slot} burn の状態を確定できません ` +
        `(${args.kind}, row ${args.row}: ${args.detail})`,
    );
    this.name = 'CrossChainBurnUnresolvedError';
    this.kind = args.kind;
    this.slot = args.slot;
    this.detail = args.detail;
    this.row = args.row;
    this.reburnable = args.reburnable;
    this.sourceChainId = args.sourceChainId;
    this.depositor = args.depositor;
    this.burnTxHash = args.burnTxHash;
  }
}

/** A-1: 回復専用の選択肢 (残高が請求額を割った送金元) の再開で、決定表が burn (前回の burn が
 *  動いていない・二段確認済み等) を返した。ここでは送金せず止める — 残高検査を経ていない選択肢から
 *  approve / burn に進ませないため。保存記録はそのまま残すので、親の直接払いのロックも外れない。 */
export class CrossChainRecoveryBurnBlockedError extends Error {
  readonly slot: BurnSlot;
  readonly row: number;
  readonly sourceChainId: number;

  constructor(args: { slot: BurnSlot; row: number; sourceChainId: number }) {
    super(
      `cross-chain execute: 回復専用の選択肢では ${args.slot} burn を送りません ` +
        `(row ${args.row}, source ${args.sourceChainId})`,
    );
    this.name = 'CrossChainRecoveryBurnBlockedError';
    this.slot = args.slot;
    this.row = args.row;
    this.sourceChainId = args.sourceChainId;
  }
}

export class CrossChainQuoteExpiredError extends Error {
  constructor(readonly replacementQuote?: AcceptedQuote) {
    super('Forwarding quote expired or exceeded; review and accept a new quote');
    this.name = 'CrossChainQuoteExpiredError';
  }
}
export class CrossChainForwardPendingError extends Error {
  constructor(readonly resume: CctpResumeState) {
    super('Arc forwarding awaits on-chain verification');
    this.name = 'CrossChainForwardPendingError';
  }
}
