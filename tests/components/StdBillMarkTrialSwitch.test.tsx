// K4b: マイページの「その端末だけの試しのスイッチ」(components/StdBillMarkTrialSwitch.tsx・lib/stdBillMarkTrial.ts)。
// ?stdmark=on で ON (localStorage の key = '1')・?stdmark=off で OFF (key を消す)・ほかの値と無いときは変えない。ON の間だけ 1 行。
// 保存の読み書きが throw しても止まらない (OFF と読む)。
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StdBillMarkTrialSwitch } from '@/components/StdBillMarkTrialSwitch';
import { STD_BILL_MARK_TRIAL_KEY, isStdBillMarkTrialOn } from '@/lib/stdBillMarkTrial';
import ja from '../../messages/ja.json';
import en from '../../messages/en.json';

const LABEL = ja.MePage.stdMarkTrial;

function openMe(query: string) {
  window.history.replaceState(null, '', `/ja/me${query}`);
  return render(<StdBillMarkTrialSwitch label={LABEL} />);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('試しのスイッチの保存 (lib/stdBillMarkTrial.ts)', () => {
  it('key は 1 つ (openpay:std-bill-mark-trial:v1)・既定は OFF・"1" のときだけ ON', () => {
    expect(STD_BILL_MARK_TRIAL_KEY).toBe('openpay:std-bill-mark-trial:v1');
    expect(isStdBillMarkTrialOn()).toBe(false);
    for (const value of ['0', 'on', 'true', '']) {
      window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, value);
      expect(isStdBillMarkTrialOn()).toBe(false);
    }
    window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');
    expect(isStdBillMarkTrialOn()).toBe(true);
  });

  it('読み込みが throw しても OFF と読む (throw しない)', () => {
    window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(isStdBillMarkTrialOn()).toBe(false);
  });
});

describe('マイページのスイッチ (components/StdBillMarkTrialSwitch.tsx)', () => {
  it('?stdmark=on で ON にし、1 行を出す', () => {
    openMe('?stdmark=on');
    expect(window.localStorage.getItem(STD_BILL_MARK_TRIAL_KEY)).toBe('1');
    expect(screen.getByText(LABEL)).toBeInTheDocument();
  });

  it('?stdmark=off で OFF にし (key を消す)、何も出さない', () => {
    window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');
    const { container } = openMe('?stdmark=off');
    expect(window.localStorage.getItem(STD_BILL_MARK_TRIAL_KEY)).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('param が無い・ほかの値なら変えない (ON のままなら 1 行・OFF のままなら何も出さない)', () => {
    window.localStorage.setItem(STD_BILL_MARK_TRIAL_KEY, '1');
    const on = openMe('');
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    on.unmount();
    const other = openMe('?stdmark=yes');
    expect(window.localStorage.getItem(STD_BILL_MARK_TRIAL_KEY)).toBe('1');
    expect(screen.getByText(LABEL)).toBeInTheDocument();
    other.unmount();

    window.localStorage.clear();
    const { container } = openMe('?stdmark=1');
    expect(window.localStorage.getItem(STD_BILL_MARK_TRIAL_KEY)).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it('保存が throw するブラウザでも止まらない (ON にできない = 何も出さない)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { container } = openMe('?stdmark=on');
    expect(container).toBeEmptyDOMElement();
  });

  it('1 行の文は ja / en の MePage.stdMarkTrial (運営者に見せる文・試験中とこの端末だけ・戻し方)', () => {
    expect(ja.MePage.stdMarkTrial).toBe('試験中: この端末の通常決済の支払いに会計の印を付けます (この端末だけ・?stdmark=off で戻せます)');
    expect(en.MePage.stdMarkTrial).toBe(
      'Trial: standard payments from this device carry the bill mark (this device only; open with ?stdmark=off to turn it off)',
    );
  });
});
