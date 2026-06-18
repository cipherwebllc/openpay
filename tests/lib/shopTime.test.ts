// lib/shopTime.ts (Phase 4 時間系・Asia/Tokyo 固定) の純ロジック。now は固定 ms を注入。
import { describe, it, expect } from 'vitest';
import {
  parseHHMM,
  formatHHMM,
  tokyoMinutesOfDay,
  tokyoHHMM,
  tokyoTimeOfDayToMs,
  isPastLastOrder,
  earliestPickup,
  pickupSlots,
  sanitizeMinLead,
  PICKUP_SLOT_MIN,
  PICKUP_MAX_SLOTS,
  MIN_LEAD_MAX,
} from '@/lib/shopTime';

const SLOT_MS = PICKUP_SLOT_MIN * 60_000;
// Tokyo 2024-01-15 12:00 = UTC 03:00 (UTC+9)。15分グリッド境界。
const TOKYO_NOON = Date.UTC(2024, 0, 15, 3, 0);

describe('parseHHMM / formatHHMM', () => {
  it('parseHHMM: 有効な HH:mm を分へ', () => {
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('09:30')).toBe(570);
    expect(parseHHMM('23:59')).toBe(1439);
  });
  it('parseHHMM: 不正は null', () => {
    expect(parseHHMM('24:00')).toBeNull(); // 時 範囲外
    expect(parseHHMM('12:60')).toBeNull(); // 分 範囲外
    expect(parseHHMM('9:30')).toBeNull(); // 1 桁時 不可
    expect(parseHHMM('')).toBeNull();
    expect(parseHHMM(930)).toBeNull();
    expect(parseHHMM(undefined)).toBeNull();
  });
  it('formatHHMM: 分を HH:mm へ・範囲外は null', () => {
    expect(formatHHMM(0)).toBe('00:00');
    expect(formatHHMM(570)).toBe('09:30');
    expect(formatHHMM(1439)).toBe('23:59');
    expect(formatHHMM(1440)).toBeNull();
    expect(formatHHMM(-1)).toBeNull();
  });
});

describe('tokyoMinutesOfDay / tokyoHHMM', () => {
  it('UTC を Tokyo 壁時計へ (+9h)', () => {
    expect(tokyoMinutesOfDay(TOKYO_NOON)).toBe(12 * 60); // 720
    expect(tokyoHHMM(TOKYO_NOON)).toBe('12:00');
  });
  it('日跨ぎ: UTC 20:00 → Tokyo 翌 05:00', () => {
    const utc2000 = Date.UTC(2024, 0, 15, 20, 0);
    expect(tokyoMinutesOfDay(utc2000)).toBe(5 * 60); // 300
    expect(tokyoHHMM(utc2000)).toBe('05:00');
  });
});

describe('tokyoTimeOfDayToMs', () => {
  it('同日 Tokyo の指定時刻の絶対 ms', () => {
    // ref=Tokyo 12:00 Jan15 / 22:00 → Tokyo 22:00 Jan15 = UTC 13:00 Jan15
    expect(tokyoTimeOfDayToMs(TOKYO_NOON, 22 * 60)).toBe(Date.UTC(2024, 0, 15, 13, 0));
    // 00:00 → Tokyo 当日 00:00 = UTC 前日 15:00
    expect(tokyoTimeOfDayToMs(TOKYO_NOON, 0)).toBe(Date.UTC(2024, 0, 14, 15, 0));
  });
});

describe('isPastLastOrder (同日セマンティクス)', () => {
  it('ラストオーダー前は false / 以降は true', () => {
    expect(isPastLastOrder(TOKYO_NOON, '22:00')).toBe(false); // 12:00 < 22:00
    const tokyo2200 = Date.UTC(2024, 0, 15, 13, 0); // Tokyo 22:00
    expect(isPastLastOrder(tokyo2200, '22:00')).toBe(true); // >= 境界
    const tokyo2230 = Date.UTC(2024, 0, 15, 13, 30);
    expect(isPastLastOrder(tokyo2230, '22:00')).toBe(true);
  });
  it('未設定/不正は制限なし (false)', () => {
    expect(isPastLastOrder(TOKYO_NOON, undefined)).toBe(false);
    expect(isPastLastOrder(TOKYO_NOON, 'bad')).toBe(false);
  });
});

describe('earliestPickup', () => {
  it('境界上 + lead 0 はそのまま', () => {
    expect(earliestPickup(TOKYO_NOON, 0)).toBe(TOKYO_NOON);
    expect(earliestPickup(TOKYO_NOON, undefined)).toBe(TOKYO_NOON);
  });
  it('lead を足して次スロット境界へ切り上げ', () => {
    // 12:00 + 20m = 12:20 → 12:30
    expect(earliestPickup(TOKYO_NOON, 20)).toBe(Date.UTC(2024, 0, 15, 3, 30));
    // 12:00 + 10m = 12:10 → 12:15
    expect(earliestPickup(TOKYO_NOON, 10)).toBe(Date.UTC(2024, 0, 15, 3, 15));
  });
  it('境界外の now も次スロットへ切り上げ', () => {
    const tokyo1207 = Date.UTC(2024, 0, 15, 3, 7); // Tokyo 12:07
    expect(earliestPickup(tokyo1207, 0)).toBe(Date.UTC(2024, 0, 15, 3, 15)); // → 12:15
  });
  it('lead は MIN_LEAD_MAX で clamp', () => {
    const r = earliestPickup(TOKYO_NOON, MIN_LEAD_MAX + 999);
    expect(r).toBe(earliestPickup(TOKYO_NOON, MIN_LEAD_MAX));
  });
});

describe('pickupSlots', () => {
  it('lastOrder まで 15分刻み (lastOrder 含む)', () => {
    // 12:00 + lead 30 = 12:30 開始, lastOrder 13:00 → 12:30/12:45/13:00 = 3 スロット
    const slots = pickupSlots(TOKYO_NOON, 30, '13:00');
    expect(slots).toEqual([
      Date.UTC(2024, 0, 15, 3, 30),
      Date.UTC(2024, 0, 15, 3, 45),
      Date.UTC(2024, 0, 15, 4, 0),
    ]);
  });
  it('lastOrder 無し → 上限本数・均等間隔', () => {
    const slots = pickupSlots(TOKYO_NOON, 0);
    expect(slots).toHaveLength(PICKUP_MAX_SLOTS);
    expect(slots[0]).toBe(TOKYO_NOON);
    expect(slots[1] - slots[0]).toBe(SLOT_MS);
  });
  it('lead が lastOrder を越える → 空 (本日 preorder 不可)', () => {
    // 12:00 + 90m = 13:30 開始, lastOrder 13:00 → 空
    expect(pickupSlots(TOKYO_NOON, 90, '13:00')).toEqual([]);
  });
  it('off-grid な lastOrder (13:07) は 15分グリッドへ floor → 13:00 まで (13:15 を出さない)', () => {
    // 12:00 + lead 30 = 12:30 開始, lastOrder 13:07 → floor 13:00 → 12:30/12:45/13:00
    expect(pickupSlots(TOKYO_NOON, 30, '13:07')).toEqual([
      Date.UTC(2024, 0, 15, 3, 30),
      Date.UTC(2024, 0, 15, 3, 45),
      Date.UTC(2024, 0, 15, 4, 0),
    ]);
  });
});

describe('sanitizeMinLead', () => {
  it('整数 1..MIN_LEAD_MAX のみ通す', () => {
    expect(sanitizeMinLead(30)).toBe(30);
    expect(sanitizeMinLead(1)).toBe(1);
    expect(sanitizeMinLead(MIN_LEAD_MAX)).toBe(MIN_LEAD_MAX);
  });
  it('範囲外/非整数/非数値は null', () => {
    expect(sanitizeMinLead(0)).toBeNull();
    expect(sanitizeMinLead(-5)).toBeNull();
    expect(sanitizeMinLead(1.5)).toBeNull();
    expect(sanitizeMinLead(MIN_LEAD_MAX + 1)).toBeNull();
    expect(sanitizeMinLead('30')).toBeNull();
  });
});
