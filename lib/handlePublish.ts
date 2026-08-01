// @handle ビルダーの公開 payload と、その公開済み baseline を扱う純関数。
// publish 送信・dirty 比較は必ず buildPublishPayload の同じ正規形を使い、UI 側に
// trim/filter の別実装を作らない。React / fetch / localStorage には依存しない。

import { getAddress, isAddress } from 'viem';
import type { HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import {
  extractHandleEmbed,
  MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_EMBEDS,
  MAX_PROFILE_LINKS,
  MAX_SOCIAL_LINKS,
  type HandleLink,
  type HandleProfile,
  type HandleReceiveMethod,
  type HandleTipConfig,
} from '@/lib/handle';
import { COLOR_PATTERN, DECIMAL_PATTERN, TIP_PRESET_MAX } from '@/lib/url';

export interface HandlePublishPayload {
  config: HandleTipConfig;
  profile: HandleProfile;
}

export interface BuildPublishPayloadOptions {
  /** ENS 解決後または生 0x 入力の受取先。未解決なら null。 */
  receiver: string | null;
  enableJpycAvalanche: boolean;
}

function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:';
}

export function buildPublishProfile(draft: HandleProfileDraft): HandleProfile {
  let featuredTaken = false;
  let embedCount = 0;
  const links: HandleLink[] = [];
  for (const entry of draft.links) {
    if (links.length >= MAX_PROFILE_LINKS) break;
    const label = entry.label.trim();
    if (entry.kind === 'heading') {
      if (!label) continue;
      // JSON.stringify の canonical キー順を {kind,label,emoji} に固定する。
      const heading: HandleLink = { kind: 'heading', label };
      const emoji = entry.emoji?.trim();
      if (emoji) heading.emoji = emoji;
      links.push(heading);
      continue;
    }
    const url = entry.url.trim();
    if (!label || !isHttpsUrl(url)) continue;
    const link: HandleLink = { label, url };
    const emoji = entry.emoji?.trim();
    if (emoji) link.emoji = emoji;
    const imageUrl = entry.imageUrl?.trim();
    if (
      imageUrl &&
      imageUrl.length <= MAX_LINK_IMAGE_URL_LEN &&
      isHttpsUrl(imageUrl)
    ) {
      link.imageUrl = imageUrl;
    }
    if (entry.featured && !featuredTaken) {
      link.featured = true;
      featuredTaken = true;
    }
    if (
      entry.embed === true &&
      embedCount < MAX_PROFILE_EMBEDS &&
      extractHandleEmbed(url)
    ) {
      link.embed = true;
      embedCount += 1;
    }
    links.push(link);
  }

  const socials = draft.socials
    .map((entry) => entry.trim())
    .filter((entry) => isHttpsUrl(entry))
    .slice(0, MAX_SOCIAL_LINKS);
  const avatar = draft.avatar.trim();

  // キー順も従来の Builder インライン実装と一致させる。JSON.stringify 時に undefined は
  // 省略されるため、publish request のバイト列を変更しない。
  return {
    bio: draft.bio.trim() || undefined,
    avatar: avatar && isHttpsUrl(avatar) ? avatar : undefined,
    socials: socials.length > 0 ? socials : undefined,
    links: links.length > 0 ? links : undefined,
    theme: draft.theme,
  };
}

export function buildPublishMethods(
  draft: HandleProfileDraft,
  enableJpycAvalanche: boolean,
): HandleReceiveMethod[] {
  const methods: HandleReceiveMethod[] = [];
  if (draft.jpycPolygon) methods.push({ token: 'jpyc', chain: 'polygon' });
  if (draft.jpycKaia) methods.push({ token: 'jpyc', chain: 'kaia' });
  if (enableJpycAvalanche && draft.jpycAvalanche) {
    methods.push({ token: 'jpyc', chain: 'avalanche' });
  }
  return methods;
}

/**
 * Builder の生 draft を publish request と dirty 比較で共有する canonical payload にする。
 * 受取先未解決または受取方法 0 件は publish 不可なので null。
 */
export function buildPublishPayload(
  draft: HandleProfileDraft,
  options: BuildPublishPayloadOptions,
): HandlePublishPayload | null {
  if (!options.receiver || !isAddress(options.receiver)) return null;

  const methods = buildPublishMethods(draft, options.enableJpycAvalanche);
  if (methods.length === 0) return null;

  const presets = draft.presetsJpyc
    .map((entry) => entry.trim())
    .filter((entry) => DECIMAL_PATTERN.test(entry) && Number(entry) > 0)
    .slice(0, TIP_PRESET_MAX);

  // config/profile のキー順は旧 publish body と同一。これを変更すると意味が同じでも
  // request body のバイト列が変わるため、tests/lib/handlePublish.test.ts で固定する。
  return {
    config: {
      to: getAddress(options.receiver),
      name: draft.name.trim() || undefined,
      color: COLOR_PATTERN.test(draft.color) ? draft.color : undefined,
      theme: draft.theme,
      methods,
      presets: { jpyc: presets },
    },
    profile: buildPublishProfile(draft),
  };
}

export function hasDroppedProfileUrl(draft: HandleProfileDraft): boolean {
  const avatar = draft.avatar.trim();
  return (
    (!!avatar && !isHttpsUrl(avatar)) ||
    draft.socials.some((entry) => {
      const value = entry.trim();
      return !!value && !isHttpsUrl(value);
    }) ||
    draft.links.some((entry) => {
      if (entry.kind === 'heading') return false;
      const value = entry.url.trim();
      const imageUrl = entry.imageUrl?.trim() ?? '';
      return (
        (!!value && !isHttpsUrl(value)) ||
        (!!imageUrl && !isHttpsUrl(imageUrl))
      );
    })
  );
}

export interface PublishedHandleSnapshot {
  handle: string;
  payload: HandlePublishPayload;
  /** GET/POST /api/handle が返した保存済み record の版。client clock で生成しない。 */
  updatedAt: number;
}

export interface HandlePublishBaselineState {
  baseline: PublishedHandleSnapshot | null;
}

export const EMPTY_HANDLE_PUBLISH_BASELINE: HandlePublishBaselineState = {
  baseline: null,
};

export type HandlePublishBaselineAction =
  | { type: 'loaded'; snapshot: PublishedHandleSnapshot }
  | { type: 'published'; snapshot: PublishedHandleSnapshot }
  | { type: 'discarded' };

export function handlePublishBaselineReducer(
  state: HandlePublishBaselineState,
  action: HandlePublishBaselineAction,
): HandlePublishBaselineState {
  switch (action.type) {
    case 'loaded':
    case 'published':
      return { baseline: action.snapshot };
    case 'discarded':
      return state.baseline === null ? state : EMPTY_HANDLE_PUBLISH_BASELINE;
  }
}

export function publishPayloadsEqual(
  left: HandlePublishPayload,
  right: HandlePublishPayload,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hasUnpublishedHandleChanges(
  state: HandlePublishBaselineState,
  editingHandle: string | null,
  currentPayload: HandlePublishPayload | null,
): boolean {
  const baseline = state.baseline;
  if (!baseline || baseline.handle !== editingHandle) return false;
  return !currentPayload || !publishPayloadsEqual(baseline.payload, currentPayload);
}

export interface RelativePublishedTime {
  dateTime: string;
  label: string;
}

/** Intl.RelativeTimeFormat だけで updatedAt を短い相対時刻へ変換する。 */
export function formatPublishedRelativeTime(
  updatedAt: number | undefined,
  locale: string,
  now = Date.now(),
): RelativePublishedTime | null {
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return null;

  const seconds = (updatedAt - now) / 1_000;
  const absoluteSeconds = Math.abs(seconds);
  let divisor = 1;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  if (absoluteSeconds >= 365 * 24 * 60 * 60) {
    divisor = 365 * 24 * 60 * 60;
    unit = 'year';
  } else if (absoluteSeconds >= 30 * 24 * 60 * 60) {
    divisor = 30 * 24 * 60 * 60;
    unit = 'month';
  } else if (absoluteSeconds >= 24 * 60 * 60) {
    divisor = 24 * 60 * 60;
    unit = 'day';
  } else if (absoluteSeconds >= 60 * 60) {
    divisor = 60 * 60;
    unit = 'hour';
  } else if (absoluteSeconds >= 60) {
    divisor = 60;
    unit = 'minute';
  }

  return {
    dateTime: date.toISOString(),
    label: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
      Math.round(seconds / divisor),
      unit,
    ),
  };
}
