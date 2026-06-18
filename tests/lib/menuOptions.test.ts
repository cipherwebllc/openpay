// メニューオプション (サイズ/トッピング) の純ロジックを検証。
import { describe, it, expect } from 'vitest';
import {
  validOptionGroups,
  effectiveUnitPrice,
  optionSummary,
  composeLineName,
  selectionKey,
  resolveSelection,
  OPTION_GROUPS_MAX,
  type OptionGroup,
} from '@/lib/menuOptions';

const size: OptionGroup = {
  id: 'g1',
  name: 'サイズ',
  type: 'single',
  required: true,
  choices: [
    { id: 's', label: '小盛り', priceDelta: '0' },
    { id: 'm', label: '並盛り', priceDelta: '100' },
    { id: 'l', label: '大盛り', priceDelta: '200' },
  ],
};
const topping: OptionGroup = {
  id: 'g2',
  name: 'トッピング',
  type: 'multi',
  choices: [
    { id: 'ebi', label: 'えび', priceDelta: '150' },
    { id: 'ika', label: 'いか', priceDelta: '120' },
  ],
};

describe('validOptionGroups', () => {
  it('正常な group/choice を保持', () => {
    const r = validOptionGroups([size, topping]);
    expect(r).toHaveLength(2);
    expect(r?.[0].choices).toHaveLength(3);
    expect(r?.[1].type).toBe('multi');
  });
  it('非配列 → undefined', () => expect(validOptionGroups('x')).toBeUndefined());
  it('priceDelta 不正な choice は drop (有効な兄弟は残る・無料化しない)', () => {
    const r = validOptionGroups([
      {
        id: 'g',
        name: 'n',
        type: 'single',
        choices: [
          { id: 'bad', label: 'l', priceDelta: 'abc' },
          { id: 'ok', label: 'm', priceDelta: '50' },
        ],
      },
    ]);
    expect(r?.[0].choices.map((c) => c.id)).toEqual(['ok']);
  });
  it('id/label 欠落の choice は drop → 全 drop の group は drop → undefined', () => {
    expect(
      validOptionGroups([
        {
          id: 'g',
          name: 'n',
          type: 'single',
          choices: [
            { id: '', label: 'x', priceDelta: '0' },
            { id: 'c', label: '', priceDelta: '0' },
          ],
        },
      ]),
    ).toBeUndefined();
  });
  it('不正 type の group は drop', () => {
    expect(
      validOptionGroups([
        { id: 'g', name: 'n', type: 'foo', choices: [{ id: 'c', label: 'l', priceDelta: '0' }] },
      ]),
    ).toBeUndefined();
  });
  it('group 上限で打切', () => {
    const many = Array.from({ length: OPTION_GROUPS_MAX + 3 }, (_, i) => ({
      id: `g${i}`,
      name: 'n',
      type: 'single',
      choices: [{ id: 'c', label: 'l', priceDelta: '0' }],
    }));
    expect(validOptionGroups(many)).toHaveLength(OPTION_GROUPS_MAX);
  });
});

describe('effectiveUnitPrice', () => {
  it('base + Σdelta', () => {
    expect(
      effectiveUnitPrice('500', [
        { id: 'l', label: '大盛り', priceDelta: '200' },
        { id: 'ebi', label: 'えび', priceDelta: '150' },
      ]),
    ).toBe('850');
  });
  it('delta 0 は不変', () => {
    expect(effectiveUnitPrice('500', [{ id: 's', label: '小', priceDelta: '0' }])).toBe('500');
  });
  it('小数を正しく加算 (trailing zero 除去)', () => {
    expect(effectiveUnitPrice('5.5', [{ id: 'x', label: 'x', priceDelta: '0.25' }])).toBe('5.75');
  });
  it('不正な delta/base は 0 扱いで throw しない (編集途中の防御)', () => {
    expect(effectiveUnitPrice('500', [{ id: 'x', label: 'x', priceDelta: '' }])).toBe('500');
    expect(effectiveUnitPrice('', [{ id: 'x', label: 'x', priceDelta: '100' }])).toBe('100');
  });
});

describe('optionSummary / composeLineName', () => {
  it('ラベルを中黒結合', () => {
    expect(
      optionSummary([
        { id: 'l', label: '大盛り', priceDelta: '0' },
        { id: 'e', label: 'えび', priceDelta: '0' },
      ]),
    ).toBe('大盛り・えび');
  });
  it('composeLineName: 選択ありで全角括弧サフィックス', () => {
    expect(composeLineName('牛丼', [{ id: 'l', label: '大盛り', priceDelta: '0' }])).toBe(
      '牛丼（大盛り）',
    );
  });
  it('composeLineName: 選択なしは素の名前', () => {
    expect(composeLineName('牛丼', [])).toBe('牛丼');
  });
});

describe('selectionKey', () => {
  it('順不同で同一キー (ソート)', () => {
    const k1 = selectionKey('i', [
      { groupId: 'g2', choiceId: 'b' },
      { groupId: 'g1', choiceId: 'a' },
    ]);
    const k2 = selectionKey('i', [
      { groupId: 'g1', choiceId: 'a' },
      { groupId: 'g2', choiceId: 'b' },
    ]);
    expect(k1).toBe(k2);
  });
  it('選択なしは itemId のみ', () => expect(selectionKey('i', [])).toBe('i'));
  it('異なる選択は別キー', () => {
    expect(selectionKey('i', [{ groupId: 'g1', choiceId: 'a' }])).not.toBe(
      selectionKey('i', [{ groupId: 'g1', choiceId: 'b' }]),
    );
  });
});

describe('resolveSelection', () => {
  it('single + multi を group 順に解決', () => {
    const r = resolveSelection([size, topping], { g1: 'l', g2: ['ebi'] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.choices.map((c) => c.id)).toEqual(['l', 'ebi']);
      expect(r.selections).toEqual([
        { groupId: 'g1', choiceId: 'l' },
        { groupId: 'g2', choiceId: 'ebi' },
      ]);
    }
  });
  it('required single 未選択 → ok:false + missingGroupId', () => {
    expect(resolveSelection([size], { g1: '' })).toEqual({ ok: false, missingGroupId: 'g1' });
  });
  it('required multi 空 → ok:false', () => {
    expect(resolveSelection([{ ...topping, required: true }], { g2: [] })).toEqual({
      ok: false,
      missingGroupId: 'g2',
    });
  });
  it('不正な choiceId は無視', () => {
    const r = resolveSelection([topping], { g2: ['nope', 'ebi'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.choices.map((c) => c.id)).toEqual(['ebi']);
  });
  it('multi は定義順 (選択クリック順に依存しない・決定論的)', () => {
    const a = resolveSelection([topping], { g2: ['ika', 'ebi'] });
    const b = resolveSelection([topping], { g2: ['ebi', 'ika'] });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.choices.map((c) => c.id)).toEqual(['ebi', 'ika']); // 定義順
      expect(b.choices.map((c) => c.id)).toEqual(['ebi', 'ika']);
    }
  });
});

describe('Codex 指摘の回帰ガード', () => {
  it('priceDelta 不正な choice は drop (無料化しない)・空/未指定は "0"', () => {
    const r = validOptionGroups([
      {
        id: 'g',
        name: 'n',
        type: 'multi',
        choices: [
          { id: 'bad', label: 'x', priceDelta: '1.2.3' }, // 不正 → drop
          { id: 'free', label: 'y', priceDelta: '' }, // 空 → "0"
          { id: 'ok', label: 'z', priceDelta: '100' },
        ],
      },
    ]);
    expect(r?.[0].choices.map((c) => c.id)).toEqual(['free', 'ok']);
    expect(r?.[0].choices[0].priceDelta).toBe('0');
  });
  it('effectiveUnitPrice は大きな base (13桁) を 0 化しない', () => {
    expect(effectiveUnitPrice('1000000000000', [{ id: 'x', label: 'x', priceDelta: '1' }])).toBe(
      '1000000000001',
    );
  });
  it('composeLineName は 80 code point 以内に収め、オプションのサフィックスを残す', () => {
    const out = composeLineName('あ'.repeat(90), [{ id: 'l', label: '大盛り', priceDelta: '0' }]);
    expect([...out].length).toBeLessThanOrEqual(80);
    expect(out.endsWith('（大盛り）')).toBe(true);
  });
  it('selectionKey は区切り文字を含む id でも衝突しない (encode)', () => {
    // 旧実装では両方 "i#a:b,c:d" に衝突しうる。
    const twoChoices = selectionKey('i', [
      { groupId: 'a', choiceId: 'b' },
      { groupId: 'c', choiceId: 'd' },
    ]);
    const oneCrafted = selectionKey('i', [{ groupId: 'a', choiceId: 'b,c:d' }]);
    expect(twoChoices).not.toBe(oneCrafted);
  });
});
