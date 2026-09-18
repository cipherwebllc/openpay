// 表示用の flag 判定 (isArcGatewayFlagOn) が、決済設定側の parseArcGateway と同じ真偽規則であることを固定する。
// 乖離すると「画面は Arc 対応と言うのに 402 に Arc が無い」(またはその逆) という開示の食い違いになる。

import { describe, expect, it } from 'vitest';
import { isArcGatewayFlagOn } from '@/lib/x402/arcGatewayFlag';
import { parseArcGateway } from '@/lib/x402/config';

const PAY_TO = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81' as const;

describe('isArcGatewayFlagOn', () => {
  it.each([undefined, '', '0', 'false', 'TRUE', ' 1', '1 ', 'yes', 'on'])(
    '%j は OFF (parseArcGateway と一致)',
    (raw) => {
      expect(isArcGatewayFlagOn(raw)).toBe(false);
      expect(parseArcGateway({ flag: raw, network: 'base', payTo: PAY_TO }).enabled).toBe(false);
    },
  );

  it.each(['1', 'true'])('%j は ON (parseArcGateway と一致)', (raw) => {
    expect(isArcGatewayFlagOn(raw)).toBe(true);
    expect(parseArcGateway({ flag: raw, network: 'base', payTo: PAY_TO }).enabled).toBe(true);
  });
});
