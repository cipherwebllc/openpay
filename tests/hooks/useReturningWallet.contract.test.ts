import { afterEach, describe, expect, it } from 'vitest';
import { createConfig, createStorage, http } from 'wagmi';
import { connect, disconnect } from 'wagmi/actions';
import { mock } from 'wagmi/connectors';
import { polygon } from 'viem/chains';
import { RETURNING_WALLET_PREPAINT } from '@/hooks/useReturningWallet';

// 描画前 script が読む `wagmi.store` の形は wagmi の内部 (zustand persist) に依存する。wagmi の更新で key や形が変わると、
// 帯が黙って出なくなる (手で書いた保存値を使うテストはすべて通ったまま)。実物の wagmi に接続・切断させて確かめる。
const GLOBAL = '__openpayReturningWallet';
const win = window as unknown as Record<string, unknown>;

function runPrepaint(): boolean | undefined {
  const parent = document.createElement('div');
  const script = document.createElement('script');
  parent.appendChild(script);
  const desc = Object.getOwnPropertyDescriptor(document, 'currentScript');
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
  try {
    delete win[GLOBAL];
    new Function(RETURNING_WALLET_PREPAINT)();
  } finally {
    if (desc) Object.defineProperty(document, 'currentScript', desc);
    else delete (document as unknown as Record<string, unknown>).currentScript;
  }
  return win[GLOBAL] as boolean | undefined;
}

afterEach(() => {
  window.localStorage.clear();
});

describe('描画前 script × 実物の wagmi の保存 (lib/wagmi.ts と同じ createStorage)', () => {
  it('つないだ後は目印あり、切断した後は目印なし', async () => {
    const config = createConfig({
      chains: [polygon],
      connectors: [mock({ accounts: ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'] })],
      transports: { [polygon.id]: http() },
      storage: createStorage({ storage: window.localStorage }),
    });
    await connect(config, { connector: config.connectors[0] });
    expect(runPrepaint()).toBe(true);
    await disconnect(config);
    expect(runPrepaint()).toBe(false);
  });
});
