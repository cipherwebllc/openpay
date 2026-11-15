// 「プロフ」タブ (@handle ビルダー) の下書きの型。localStorage 永続化と sanitize は
// hooks/useHandleProfileDraft.ts、公開 payload への変換は lib/handlePublish.ts。
// lib/ は hooks/ を import できない (eslint.config.mjs・F-4) ため、型だけをここに置く。

import type { HandleFont, HandleLinkLayout } from '@/lib/handle';
import type { HandleTheme } from '@/lib/handleTheme';

// ビルダーの下書きリンク (公開前の生入力)。既存 v1 保存値は kind 欠落の通常リンク。
export interface DraftRegularLink {
  kind?: never;
  label: string;
  url: string;
  emoji?: string;
  imageUrl?: string;
  featured?: boolean;
  embed?: true;
}

export interface DraftHeading {
  kind: 'heading';
  label: string;
  emoji?: string;
}

export type DraftLink = DraftRegularLink | DraftHeading;

// 受取方法は JPYC Polygon / JPYC Kaia の ON/OFF (+ env.enableJpycAvalanche=ON で JPYC Avalanche)。
// USDC (cross-chain) は着金チェーンを選べず Base 固定になるためビルダーから提供終了
// (チップタブで個別作成→リンク集へ)。
export interface HandleProfileDraft {
  to: string; // 生入力 (アドレス or ENS)・submit 時に再解決
  name: string;
  // undefined = 旧/未編集 draft の省略、空文字 = フォームでの明示クリア。
  message?: string;
  thanks?: string;
  thanksUrl?: string;
  // 旧 `webhook` は退役 (2026-10 user 裁定 R1)。保存済み下書きの値は sanitize で読まずに捨てる。
  color: string;
  jpycPolygon: boolean;
  /** USDC (Base) チップの受け入れ (2026-08-17 復活・Base 固定は user 決定)。 */
  usdcBase: boolean;
  usdcArc: boolean;
  jpycKaia: boolean;
  // Avalanche は env.enableJpycAvalanche=ON のときだけビルダーで提供 (Phase 2・既定 OFF)。
  jpycAvalanche: boolean;
  presetsJpyc: string[];
  bio: string;
  avatar: string;
  cover: string;
  font: HandleFont;
  linkLayout: HandleLinkLayout;
  socials: string[]; // SNS プロフィール URL (アイコンはドメイン自動判定)
  links: DraftLink[];
  // 着せ替えテーマ (clean 既定)。公開ページ/プレビューの見た目を切替える。
  theme: HandleTheme;
}
