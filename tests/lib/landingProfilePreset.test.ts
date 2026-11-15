import { describe, expect, it } from 'vitest';
import {
  LANDING_ACCENTS,
  LANDING_ACCENT_KEYS,
  readLandingLook,
  withLandingLook,
  withoutLandingLook,
} from '@/lib/landingProfilePreset';
import { HANDLE_THEMES } from '@/lib/handleThemeKey';
import ja from '@/messages/ja.json';
import en from '@/messages/en.json';

// トップの見本の 5 色と、見本で選んだテーマと色を作成画面へ持って行く query (plans/lp-polish-2026-11.md P6)。

describe('見本の色の表', () => {
  it('5 色の名前と値は見本と作成画面が共有する 1 つの表 (名前ごとの色名の文言が ja / en にある)', () => {
    expect(LANDING_ACCENTS).toEqual({
      blue: '#2563eb',
      green: '#059669',
      rose: '#e11d48',
      amber: '#d97706',
      violet: '#7c3aed',
    });
    expect(LANDING_ACCENT_KEYS).toEqual(['blue', 'green', 'rose', 'amber', 'violet']);
    for (const messages of [ja, en]) {
      for (const key of LANDING_ACCENT_KEYS) {
        const name = `profileDemoColor${key[0].toUpperCase()}${key.slice(1)}` as keyof typeof messages.Landing;
        expect(messages.Landing[name]).toEqual(expect.any(String));
      }
    }
  });
});

describe('withLandingLook (「出品をはじめる」の行き先に付ける)', () => {
  it('今の query (tab) の後ろに theme と色の名前を付ける・query が無ければ ? から', () => {
    expect(withLandingLook('/ja/create?tab=profile', 'night', 'violet')).toBe('/ja/create?tab=profile&theme=night&color=violet');
    expect(withLandingLook('/en/create', 'gradient', 'blue')).toBe('/en/create?theme=gradient&color=blue');
  });

  it('付けたものは readLandingLook でそのまま読み戻せる (全部のテーマ × 全部の色)', () => {
    for (const theme of HANDLE_THEMES) {
      for (const accent of LANDING_ACCENT_KEYS) {
        const href = withLandingLook('/ja/create?tab=profile', theme, accent);
        expect(readLandingLook(href.slice(href.indexOf('?')))).toEqual({ theme, color: LANDING_ACCENTS[accent] });
      }
    }
  });
});

describe('readLandingLook (作成画面で読む)', () => {
  it('theme も color も無ければ null (URL を触らない)', () => {
    expect(readLandingLook('')).toBeNull();
    expect(readLandingLook('?tab=profile')).toBeNull();
  });

  it('両方正しければ、テーマと色 (hex) を返す', () => {
    expect(readLandingLook('?tab=profile&theme=night&color=violet')).toEqual({ theme: 'night', color: '#7c3aed' });
  });

  it('同じ名前が重なったときは先頭の値を採る', () => {
    expect(readLandingLook('?theme=night&theme=bold&color=rose&color=green')).toEqual({ theme: 'night', color: '#e11d48' });
    // 先頭が不正なら、後ろに正しい値があってもその名前は入れない。
    expect(readLandingLook('?theme=neon&theme=bold&color=black&color=green')).toEqual({});
  });

  it('片方だけ正しいときは、正しい方だけ', () => {
    expect(readLandingLook('?theme=night&color=black')).toEqual({ theme: 'night' });
    expect(readLandingLook('?theme=dark&color=rose')).toEqual({ color: '#e11d48' });
    expect(readLandingLook('?color=amber')).toEqual({ color: '#d97706' });
  });

  it('両方不正・hex を直接書いた色・表に無い名前 (Object の既定の名前を含む) は何も入れない (query はあるので {} )', () => {
    expect(readLandingLook('?theme=xxx&color=%23000000')).toEqual({});
    expect(readLandingLook('?theme=Night&color=Violet')).toEqual({});
    expect(readLandingLook('?theme=toString&color=constructor')).toEqual({});
    expect(readLandingLook('?theme=&color=')).toEqual({});
  });
});

describe('withoutLandingLook (読んだ後に URL から消す)', () => {
  it('theme と color だけを消し、tab と hash は残す', () => {
    expect(withoutLandingLook('/ja/create', '?tab=profile&theme=night&color=violet', '#handle-profile-heading')).toBe(
      '/ja/create?tab=profile#handle-profile-heading',
    );
    expect(withoutLandingLook('/ja/create', '?theme=night&tab=profile&color=violet', '')).toBe('/ja/create?tab=profile');
  });

  it('ほかの query が無ければ ? も付けない', () => {
    expect(withoutLandingLook('/ja/create', '?theme=night&color=violet', '#x')).toBe('/ja/create#x');
  });
});
