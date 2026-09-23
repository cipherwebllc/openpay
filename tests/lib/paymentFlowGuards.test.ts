import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  isRelayIpRateLimitedError,
  isRelayResponseUnknownError,
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
  recoveryState?: 'auto' | 'exhausted' | null;
  data?: { success: boolean; pending?: boolean };
  error?: Error | null;
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
};
type Guards = { flowPending: boolean; settledNoRetry: boolean; gaslessStoreUnavailable: boolean };

// Characterize the actual inline expressions without refactoring the money path or
// copying its logic into a test-only implementation. Only named pure declarations
// are evaluated: no React render, hook, wallet, storage or network side effects.
function readDerivePaymentFlowGuards(policy: Policy) {
  const component = { pay: 'PaymentForm', checkout: 'CheckoutForm', tip: 'TipForm' }[policy];
  const filename = `components/${component}.tsx`;
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = [
    'relayResponseUnknown', 'relayAmbiguous', 'gaslessAmbiguous',
    'gaslessStoreUnavailable', 'relayIpRateLimited',
    policy === 'checkout' ? 'paymentFlowPending' : 'directFlowPending',
    ...(policy === 'checkout' ? [] : ['arcRecoveryScanning', 'directSettledNoRetry']),
    'flowPending', 'settledNoRetry',
  ];
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text)) {
      expect(node.initializer, node.name.text).toBeDefined();
      expect(declarations.has(node.name.text), node.name.text).toBe(false);
      declarations.set(node.name.text, `const ${node.name.text} = ${node.initializer!.getText(source)};`);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect([...declarations.keys()].sort()).toEqual([...names].sort());
  const evaluate = new Function('input', 'isRelayResponseUnknownError', 'isRelayIpRateLimitedError', `
    const { isStandard, useRelay, standard, relay, gasless, ownsStandardAttempt,
      crossChainLocked, crossChainResult, orderAdmissionPending, params, address,
      preview, arcScannedScope, arcRecoveryScope } = input;
    ${[...declarations.values()].join('\n')}
    return { flowPending, settledNoRetry, gaslessStoreUnavailable };
  `) as (input: object, unknown: typeof isRelayResponseUnknownError, limited: typeof isRelayIpRateLimitedError) => Guards;
  return (route: Route, state: State = {}) => evaluate({
    isStandard: route === 'standard',
    useRelay: route === 'relay-free' || route === 'relay-recover',
    standard: { isRestoring: false, isPending: false, isUnknown: false, hasActiveIntent: false, ...state.standard },
    relay: { isRestoring: false, isPending: false, hasActiveIntent: false, ...state.relay },
    gasless: { isPending: false, isUnknown: false, pendingStoreUnavailable: false, ...state.gasless },
    ownsStandardAttempt: state.ownsStandardAttempt ?? false,
    crossChainLocked: state.crossChainLocked ?? false,
    crossChainResult: state.crossChainResult,
    orderAdmissionPending: state.orderAdmissionPending ?? false,
    params: { token: 'usdc', chain: 'arc' },
    address: '0x1111111111111111111111111111111111111111',
    preview: false,
    arcScannedScope: state.arcScannedScope ?? 'scanned',
    arcRecoveryScope: 'scanned',
  }, isRelayResponseUnknownError, isRelayIpRateLimitedError);
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
