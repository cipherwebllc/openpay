import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { deriveCheckoutGuards, type CheckoutGuardInput } from '@/lib/paymentFlowGuards/checkout';
import { derivePayGuards, type PayGuardInput } from '@/lib/paymentFlowGuards/pay';
import { deriveTipGuards, type TipGuardInput } from '@/lib/paymentFlowGuards/tip';
import {
  RelayIpRateLimitedError,
  RelayResponseUnknownError,
} from '@/lib/relay/relayResponseError';

type Policy = 'pay' | 'checkout' | 'tip';
type Route = 'standard' | 'relay-free' | 'relay-recover' | 'pimlico' | 'circle';
type HookState = {
  isRestoring?: boolean;
  isPending?: boolean;
  isUnknown?: boolean;
  isSuccess?: boolean;
  isFeeError?: boolean;
  hasActiveIntent?: boolean;
  pendingStoreUnavailable?: boolean;
  orderPaymentHold?: boolean;
  recoveryState?: 'auto' | 'exhausted' | null;
  data?: { success: boolean; pending?: boolean };
  error?: Error | null;
};
// submit readiness の入力 (flow 状態以外)。既定は「全て満たす」で、行ごとに 1 つずつ崩す。
type Readiness = {
  isConnected: boolean;
  wrongChain: boolean;
  saData: object | undefined;
  merchantReceives: bigint;
  customerPays: bigint;
  insufficientBalance: boolean;
  merchantUnderflow: boolean;
  quoteReady: boolean;
  expired: boolean;
  timeMeasured: boolean;
  expiresAt: number | undefined;
  standardReady: boolean;
  preview: boolean;
};
type State = {
  standard?: HookState;
  relay?: HookState;
  gasless?: HookState;
  ownsStandardAttempt?: boolean;
  crossChainLocked?: boolean;
  crossChainResult?: object;
  orderAdmissionPending?: boolean;
  arcScannedScope?: string;
  ready?: Partial<Readiness>;
};
type Guards = { flowPending: boolean; settledNoRetry: boolean; gaslessStoreUnavailable: boolean };
type Submit = { canSubmit: boolean; paymentReady?: boolean };
// フォームが banner・エラー表示・ボタン文言に使う policy の出力 (R14 review N1)。Checkout は
// directFlowPending / directSettledNoRetry を持たない。relayIpRateLimited は有無だけを見る。
const UI_FIELDS = {
  pay: ['relayAmbiguous', 'gaslessAmbiguous', 'relayIpRateLimited', 'directFlowPending', 'gasQuoteReady', 'directSettledNoRetry'],
  checkout: ['relayAmbiguous', 'gaslessAmbiguous', 'relayIpRateLimited', 'gasQuoteReady'],
  tip: ['relayAmbiguous', 'gaslessAmbiguous', 'relayIpRateLimited', 'directFlowPending', 'gasQuoteReady', 'directSettledNoRetry'],
} as const;
type Evaluated = Guards & Submit & { ui: Record<string, boolean> };
const POLICY_FN = { pay: 'derivePayGuards', checkout: 'deriveCheckoutGuards', tip: 'deriveTipGuards' } as const;

function uiOf(policy: Policy, result: Record<string, unknown>): Record<string, boolean> {
  return Object.fromEntries(UI_FIELDS[policy].map((name) => [
    name,
    name === 'relayIpRateLimited' ? result[name] != null : result[name] === true,
  ]));
}

const READY: Readiness = {
  isConnected: true,
  wrongChain: false,
  saData: {},
  merchantReceives: 1n,
  customerPays: 1n,
  insufficientBalance: false,
  merchantUnderflow: false,
  quoteReady: true,
  expired: false,
  timeMeasured: true,
  expiresAt: undefined,
  standardReady: true,
  preview: false,
};

// R14 で 3 フォームの判定式は lib/paymentFlowGuards/{pay,checkout,tip}.ts へ式を変えずに移った
// (移動前は component の inline 宣言を parse して評価していた・真理値表は移動前と同一)。ここでは
// 各フォームの policy を直接呼ぶ。React の render・hook・wallet・storage・network は介さない。
// component 側が policy を呼び、判定を再び inline 化していないことも併せて固定する。
function readPolicy(policy: Policy): (input: ReturnType<typeof buildInput>) => Evaluated {
  const component = { pay: 'PaymentForm', checkout: 'CheckoutForm', tip: 'TipForm' }[policy];
  const filename = `components/${component}.tsx`;
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const inline: string[] = [];
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && ['flowPending', 'settledNoRetry', 'gaslessStoreUnavailable', 'canSubmit', 'paymentReady'].includes(node.name.text)) {
      inline.push(node.name.text);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === POLICY_FN[policy]) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(inline).toEqual([]);
  expectShorthandCallSite(policy, source, calls);
  return (input) => callPolicy(policy, input);
}

// 呼び出し側の配線も固定する (R14 review S1): 引数は component の同名変数をそのまま渡す shorthand
// だけにし (`standardReady: true` のような固定値・別名の差し込みを禁止)、渡す名前の集合は policy の
// 引数と一致させる。移動前は inline 式が component の変数を直接読んでいたのと同じ束縛になる。
function expectShorthandCallSite(policy: Policy, source: ts.SourceFile, calls: ts.CallExpression[]) {
  expect(calls).toHaveLength(1);
  const [arg] = calls[0].arguments;
  if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error(`${POLICY_FN[policy]} must take one object literal`);
  expect(arg.properties.filter((p) => !ts.isShorthandPropertyAssignment(p)).map((p) => p.getText(source))).toEqual([]);
  const policyFile = `lib/paymentFlowGuards/${policy}.ts`;
  const policySource = ts.createSourceFile(policyFile, readFileSync(policyFile, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fn = policySource.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === POLICY_FN[policy]);
  const pattern = fn?.parameters[0]?.name;
  if (!pattern || !ts.isObjectBindingPattern(pattern)) throw new Error(`${POLICY_FN[policy]} must destructure its input`);
  const parameters = pattern.elements.map((element) => element.name.getText(policySource));
  expect(arg.properties.map((p) => p.name!.getText(source)).sort()).toEqual(parameters.sort());
}

// input は policy ごとの型に `satisfies` で照合する (R14 review N2): policy 側の入力の形が変わると
// buildInput が tsc で落ち、名前ずれで undefined が黙って流れ込まない。
function callPolicy(policy: Policy, input: ReturnType<typeof buildInput>): Evaluated {
  if (policy === 'pay') {
    const result = derivePayGuards(input satisfies PayGuardInput);
    const { flowPending, settledNoRetry, gaslessStoreUnavailable, canSubmit } = result;
    return { flowPending, settledNoRetry, gaslessStoreUnavailable, canSubmit, ui: uiOf(policy, result) };
  }
  if (policy === 'checkout') {
    const result = deriveCheckoutGuards(input satisfies CheckoutGuardInput);
    const { flowPending, settledNoRetry, gaslessStoreUnavailable, canSubmit, paymentReady } = result;
    return { flowPending, settledNoRetry, gaslessStoreUnavailable, canSubmit, paymentReady, ui: uiOf(policy, result) };
  }
  const result = deriveTipGuards(input satisfies TipGuardInput);
  const { flowPending, settledNoRetry, gaslessStoreUnavailable, canSubmit } = result;
  return { flowPending, settledNoRetry, gaslessStoreUnavailable, canSubmit, ui: uiOf(policy, result) };
}

function buildInput(route: Route, state: State = {}) {
  const ready = { ...READY, ...state.ready };
  return {
    isStandard: route === 'standard',
    useRelay: route === 'relay-free' || route === 'relay-recover',
    standard: { isRestoring: false, isPending: false, isUnknown: false, isFeeError: false, isSuccess: false, hasActiveIntent: false, data: undefined, ...state.standard },
    relay: { error: null, recoveryState: null, isRestoring: false, isPending: false, hasActiveIntent: false, orderPaymentHold: false, ...state.relay },
    gasless: { isPending: false, isUnknown: false, pendingStoreUnavailable: false, ...state.gasless },
    ownsStandardAttempt: state.ownsStandardAttempt ?? false,
    crossChainLocked: state.crossChainLocked ?? false,
    crossChainResult: state.crossChainResult,
    orderAdmissionPending: state.orderAdmissionPending ?? false,
    params: { token: 'usdc', chain: 'arc', expiresAt: ready.expiresAt },
    address: '0x1111111111111111111111111111111111111111',
    preview: ready.preview,
    arcScannedScope: state.arcScannedScope ?? 'scanned',
    arcRecoveryScope: 'scanned',
    isConnected: ready.isConnected,
    wrongChain: ready.wrongChain,
    saData: ready.saData,
    breakdown: { merchantReceives: ready.merchantReceives, customerPays: ready.customerPays },
    insufficientBalance: ready.insufficientBalance,
    merchantUnderflow: ready.merchantUnderflow,
    activeQuote: { data: ready.quoteReady ? {} : undefined },
    expired: ready.expired,
    timeMeasured: ready.timeMeasured,
    standardReady: ready.standardReady,
  };
}

function readDerivePaymentFlowGuards(policy: Policy) {
  const evaluate = readPolicy(policy);
  return (route: Route, state: State = {}): Guards => {
    const { flowPending, settledNoRetry, gaslessStoreUnavailable } = evaluate(buildInput(route, state));
    return { flowPending, settledNoRetry, gaslessStoreUnavailable };
  };
}

function readDeriveSubmit(policy: Policy) {
  const evaluate = readPolicy(policy);
  return (route: Route, state: State = {}): Submit => {
    const { canSubmit, paymentReady } = evaluate(buildInput(route, state));
    return policy === 'checkout' ? { canSubmit, paymentReady } : { canSubmit };
  };
}

// Columns are standard / relay (free + recover) / gasless (Pimlico + Circle).
// O = open, P = pending, L = no retry, B = both. First run against all three
// pre-F8 forms; only Tip's approved relay-latch cells were then updated. Other
// policy differences (including restored standard success) stay pinned.
// Single-signal rows intentionally decouple hook flags to pin each guard input.
// The coupled rows below also pin reachable relay states with an active intent;
// in particular, the real IP-limit state blocks Tip's standard route too.
type Row = { name: string; state: State; pay: string; tip?: string; checkout?: string };
const rows: Row[] = [
  { name: 'idle', state: {}, pay: 'OOO' },
  { name: 'relay storage restoring', state: { relay: { isRestoring: true } }, pay: 'PPP' },
  { name: 'relay auto recovery', state: { relay: { recoveryState: 'auto' } }, pay: 'BBB' },
  { name: 'relay response unknown before recovery state', state: { relay: { error: new RelayResponseUnknownError() } }, pay: 'BBB' },
  { name: 'relay exhausted recovery', state: { relay: { recoveryState: 'exhausted' } }, pay: 'BBB' },
  { name: 'relay active intent without ambiguity', state: { relay: { hasActiveIntent: true } }, pay: 'LLL' },
  { name: 'relay signing', state: { relay: { isPending: true } }, pay: 'OPO' },
  { name: 'relay settled', state: { relay: { data: { success: true } } }, pay: 'OLO' },
  { name: 'relay broadcast pending', state: { relay: { data: { success: false, pending: true }, hasActiveIntent: true } }, pay: 'LLL' },
  { name: 'relay IP limit', state: { relay: { error: new RelayIpRateLimitedError(45) } }, pay: 'LLL', tip: 'OLO' },
  { name: 'relay auto recovery with active intent', state: { relay: { recoveryState: 'auto', isPending: true, hasActiveIntent: true } }, pay: 'BBB' },
  { name: 'relay response unknown with active intent', state: { relay: { error: new RelayResponseUnknownError(), hasActiveIntent: true } }, pay: 'BBB' },
  { name: 'relay exhausted recovery with active intent', state: { relay: { recoveryState: 'exhausted', error: new RelayResponseUnknownError(), hasActiveIntent: true } }, pay: 'BBB' },
  { name: 'relay IP limit with active intent', state: { relay: { error: new RelayIpRateLimitedError(45), hasActiveIntent: true } }, pay: 'LLL' },
  { name: 'relay rejected', state: { relay: { error: new Error('rate_limited') } }, pay: 'OOO' },
  { name: 'relay reverted', state: { relay: { data: { success: false } } }, pay: 'OOO' },
  { name: 'standard restoring', state: { standard: { isRestoring: true } }, pay: 'PPP', tip: 'POO' },
  { name: 'standard pending', state: { standard: { isPending: true } }, pay: 'POO' },
  { name: 'standard active intent', state: { standard: { hasActiveIntent: true } }, pay: 'LLL', tip: 'LOO' },
  { name: 'standard unknown', state: { standard: { isUnknown: true } }, pay: 'LOO', tip: 'BOO' },
  { name: 'standard fee error', state: { standard: { isFeeError: true } }, pay: 'LOO' },
  { name: 'standard owned success', state: { standard: { isSuccess: true, data: { success: true } }, ownsStandardAttempt: true }, pay: 'LOO' },
  { name: 'standard restored success permits a new tip', state: { standard: { isSuccess: true, data: { success: true } } }, pay: 'LOO', tip: 'OOO' },
  { name: 'gasless pending', state: { gasless: { isPending: true } }, pay: 'OOP' },
  { name: 'gasless unknown', state: { gasless: { isUnknown: true } }, pay: 'BBB', tip: 'OOB' },
  { name: 'gasless settled', state: { gasless: { data: { success: true } } }, pay: 'OOL' },
  { name: 'gasless reverted', state: { gasless: { data: { success: false } } }, pay: 'OOO' },
  { name: 'cross-chain executing', state: { crossChainLocked: true }, pay: 'PPP', checkout: 'OOO' },
  { name: 'cross-chain settled', state: { crossChainResult: {} }, pay: 'LLL', checkout: 'OOO' },
  { name: 'Arc recovery scan', state: { arcScannedScope: 'unscanned' }, pay: 'PPP', checkout: 'OOO' },
  { name: 'order admission', state: { orderAdmissionPending: true }, pay: 'OOO', checkout: 'PPP' },
];

describe.each(['pay', 'checkout', 'tip'] as const)('%s payment flow guard truth table', (policy) => {
  const derive = readDerivePaymentFlowGuards(policy);
  describe.each(['standard', 'relay-free', 'relay-recover', 'pimlico', 'circle'] as const)('%s', (route) => {
    const column = route === 'standard' ? 0 : route.startsWith('relay') ? 1 : 2;
    it.each(rows)('$name', (row) => {
      const expected = (row[policy] ?? row.pay)[column];
      expect(derive(route, row.state)).toEqual({
        flowPending: expected === 'P' || expected === 'B',
        settledNoRetry: expected === 'L' || expected === 'B',
        gaslessStoreUnavailable: false,
      });
    });
    it('pending-store failure blocks only gasless, separately from an ambiguous payment', () => {
      expect(derive(route, { gasless: { pendingStoreUnavailable: true } })).toEqual({
        flowPending: false,
        settledNoRetry: false,
        gaslessStoreUnavailable: column === 2,
      });
    });
  });
});

// R14 (Phase 6) で policy を外へ移す前に、移動前のコードで捕捉した submit 可否の真理値表。
// 列は上と同じ standard / relay / gasless。1 = 送信可、0 = 不可。pay の値を既定とし、
// フォーム固有の差 (Tip の route 限定ロック・Checkout の注文受付と同一店舗 hold・Pay の FX 期限)
// だけを tip / checkout 列で上書きする。checkoutReady は Checkout の paymentReady
// (admission の await 後に onSubmit が読む readiness) で、既定は checkout 列と同じ。
type SubmitRow = { name: string; state: State; pay: string; tip?: string; checkout?: string; checkoutReady?: string };
const submitRows: SubmitRow[] = [
  // readiness: 1 つずつ崩す
  { name: 'all ready', state: {}, pay: '111' },
  { name: 'wallet disconnected', state: { ready: { isConnected: false } }, pay: '000' },
  { name: 'wrong chain', state: { ready: { wrongChain: true } }, pay: '000' },
  { name: 'smart account not ready', state: { ready: { saData: undefined } }, pay: '110' },
  { name: 'Tip standard engine not loaded', state: { ready: { standardReady: false } }, pay: '111', tip: '011' },
  { name: 'merchant receives zero', state: { ready: { merchantReceives: 0n } }, pay: '000' },
  { name: 'customer pays zero', state: { ready: { customerPays: 0n } }, pay: '000' },
  { name: 'insufficient balance', state: { ready: { insufficientBalance: true } }, pay: '000' },
  { name: 'gas quote pending', state: { ready: { quoteReady: false } }, pay: '110' },
  { name: 'merchant underflow', state: { ready: { merchantUnderflow: true } }, pay: '000', tip: '111' },
  { name: 'FX QR expired', state: { ready: { expired: true } }, pay: '000', tip: '111', checkout: '111' },
  { name: 'FX QR before time is measured', state: { ready: { expiresAt: 1_800_000_000_000, timeMeasured: false } }, pay: '000', tip: '111', checkout: '111' },
  { name: 'FX QR after time is measured', state: { ready: { expiresAt: 1_800_000_000_000 } }, pay: '111' },
  { name: 'no FX expiry before time is measured', state: { ready: { timeMeasured: false } }, pay: '111' },
  { name: 'Tip preview', state: { ready: { preview: true } }, pay: '111', tip: '000' },
  { name: 'same-merchant order payment hold', state: { relay: { orderPaymentHold: true } }, pay: '111', checkout: '000' },
  // post-await admission: 受付中は canSubmit だけが閉じ、await 後に読む paymentReady は開いたまま
  { name: 'order admission in flight', state: { orderAdmissionPending: true }, pay: '111', checkout: '000', checkoutReady: '111' },
  { name: 'order admission in flight then wallet disconnected', state: { orderAdmissionPending: true, ready: { isConnected: false } }, pay: '000' },
  { name: 'order admission in flight then chain switched', state: { orderAdmissionPending: true, ready: { wrongChain: true } }, pay: '000' },
  { name: 'order admission in flight then same-merchant hold', state: { orderAdmissionPending: true, relay: { orderPaymentHold: true } }, pay: '111', checkout: '000' },
  // duplicate submit: 1 回目の click を hook が受け取った直後の状態
  { name: 'duplicate submit: standard in flight', state: { standard: { isPending: true } }, pay: '011' },
  { name: 'duplicate submit: relay signing', state: { relay: { isPending: true } }, pay: '101' },
  { name: 'duplicate submit: relay intent persisted before response', state: { relay: { isPending: true, hasActiveIntent: true } }, pay: '000' },
  { name: 'duplicate submit: gasless in flight', state: { gasless: { isPending: true } }, pay: '110' },
  { name: 'duplicate submit: cross-chain executing', state: { crossChainLocked: true }, pay: '000', checkout: '111' },
  // mixed pending state: 別経路の hook に未解決の状態が残ったまま route が変わった
  { name: 'mixed: relay settled, other route selected', state: { relay: { data: { success: true } } }, pay: '101' },
  { name: 'mixed: standard pending while relay restoring', state: { standard: { isPending: true }, relay: { isRestoring: true } }, pay: '000' },
  { name: 'mixed: gasless pending while relay IP limited', state: { gasless: { isPending: true }, relay: { error: new RelayIpRateLimitedError(45) } }, pay: '000', tip: '100' },
  { name: 'mixed: standard unknown and gasless settled', state: { standard: { isUnknown: true }, gasless: { data: { success: true } } }, pay: '010' },
  { name: 'mixed: gasless unknown, relay selected', state: { gasless: { isUnknown: true } }, pay: '000', tip: '110' },
  { name: 'mixed: relay broadcast pending and standard fee error', state: { relay: { data: { success: false, pending: true } }, standard: { isFeeError: true } }, pay: '001' },
  { name: 'mixed: gasless store unavailable and relay signing', state: { gasless: { pendingStoreUnavailable: true }, relay: { isPending: true } }, pay: '100' },
  // restored state: 同一タブの storage から復元された状態
  { name: 'restored: relay restoring on mount', state: { relay: { isRestoring: true } }, pay: '000' },
  { name: 'restored: relay intent in auto recovery', state: { relay: { hasActiveIntent: true, recoveryState: 'auto' } }, pay: '000' },
  { name: 'restored: standard restoring on mount', state: { standard: { isRestoring: true } }, pay: '000', tip: '011' },
  { name: 'restored: standard active intent', state: { standard: { hasActiveIntent: true } }, pay: '000', tip: '011' },
  { name: 'restored: standard success from another attempt', state: { standard: { isSuccess: true, data: { success: true } } }, pay: '011', tip: '111' },
  { name: 'restored: standard success owned by this form', state: { standard: { isSuccess: true, data: { success: true } }, ownsStandardAttempt: true }, pay: '011' },
  { name: 'restored: gasless unresolved UserOperation', state: { gasless: { isUnknown: true } }, pay: '000', tip: '110' },
  { name: 'restored: gasless pending store unreadable', state: { gasless: { pendingStoreUnavailable: true } }, pay: '110' },
  { name: 'restored: cross-chain result', state: { crossChainResult: {} }, pay: '000', checkout: '111' },
  { name: 'restored: Arc recovery scan not finished', state: { arcScannedScope: 'unscanned' }, pay: '000', checkout: '111' },
];

describe.each(['pay', 'checkout', 'tip'] as const)('%s submit readiness truth table', (policy) => {
  const derive = readDeriveSubmit(policy);
  describe.each(['standard', 'relay-free', 'relay-recover', 'pimlico', 'circle'] as const)('%s', (route) => {
    const column = route === 'standard' ? 0 : route.startsWith('relay') ? 1 : 2;
    it.each(submitRows)('$name', (row) => {
      const expected = (row[policy] ?? row.pay)[column] === '1';
      const actual = derive(route, row.state);
      if (policy === 'checkout') {
        const ready = (row.checkoutReady ?? row.checkout ?? row.pay)[column] === '1';
        expect(actual).toEqual({ canSubmit: expected, paymentReady: ready });
      } else {
        expect(actual).toEqual({ canSubmit: expected });
      }
    });
  });
});

// R14 review N1: フォームが表示に使う policy の出力 (Tip の route 限定の gaslessAmbiguous 等) を、
// 上の 2 表の全行 × 全 route で固定する。snapshot は移動前のコード (776e6c85 の inline 宣言) で捕捉した。
describe.each(['pay', 'checkout', 'tip'] as const)('%s UI outputs', (policy) => {
  it('pins the fields the form renders from', () => {
    const evaluate = readPolicy(policy);
    const table: Record<string, string> = {};
    for (const route of ['standard', 'relay-free', 'relay-recover', 'pimlico', 'circle'] as const) {
      for (const [kind, list] of [['flow', rows], ['submit', submitRows]] as const) {
        for (const row of list) {
          const { ui } = evaluate(buildInput(route, row.state));
          table[`${route} | ${kind} | ${row.name}`] = Object.entries(ui).map(([name, value]) => `${name}=${value ? 1 : 0}`).join(' ');
        }
      }
    }
    expect(table).toMatchSnapshot();
  });
});
