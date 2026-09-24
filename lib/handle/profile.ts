// link-in-bio プロフィールの厳格な書き込み検証。保存済み record の tolerant な読み出しは record.ts。
import { isHandleTheme } from '@/lib/handleThemeKey';
import { extractHandleEmbed } from './embeds';
import {
  HANDLE_FONTS, HANDLE_LINK_LAYOUTS,
  MAX_BIO_LEN, MAX_AVATAR_URL_LEN, MAX_COVER_URL_LEN, MAX_SOCIAL_LINKS,
  MAX_LINK_URL_LEN, MAX_PROFILE_LINKS, MAX_LINK_LABEL_LEN, MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_EMBEDS, isHandleFont, isHandleLinkLayout, isHttpsUrl, sanitizeEmoji,
  type HandleProfile, type HandleLink, type HandleHeading, type HandleRegularLink,
} from './schema';

export type ValidatedProfile =
  | { ok: true; profile: HandleProfile }
  | { ok: false; error: string };

// link-in-bio プロフィールの厳格検証 (書き込み経路)。https 限定・本数/長さ上限。
// 全フィールド空なら {} (= profile 無し扱い)。不正は error (黙ってドロップしない)。
export function validateProfile(raw: unknown): ValidatedProfile {
  if (raw === undefined || raw === null) return { ok: true, profile: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'invalid profile' };
  }
  const r = raw as Record<string, unknown>;
  const profile: HandleProfile = {};

  if (r.bio !== undefined && r.bio !== null) {
    if (typeof r.bio !== 'string') return { ok: false, error: 'bio must be string' };
    const bio = r.bio.trim();
    if (bio.length > MAX_BIO_LEN) return { ok: false, error: 'bio too long' };
    if (bio) profile.bio = bio;
  }

  if (r.avatar !== undefined && r.avatar !== null && r.avatar !== '') {
    if (typeof r.avatar !== 'string') {
      return { ok: false, error: 'avatar must be string' };
    }
    const avatar = r.avatar.trim();
    if (avatar) {
      if (avatar.length > MAX_AVATAR_URL_LEN) {
        return { ok: false, error: 'avatar url too long' };
      }
      if (!isHttpsUrl(avatar)) {
        return { ok: false, error: 'avatar must be an https url' };
      }
      profile.avatar = avatar;
    }
  }

  if (r.cover !== undefined && r.cover !== null && r.cover !== '') {
    if (typeof r.cover !== 'string') {
      return { ok: false, error: 'cover must be string' };
    }
    const cover = r.cover.trim();
    if (cover) {
      if (cover.length > MAX_COVER_URL_LEN) {
        return { ok: false, error: 'cover url too long' };
      }
      if (!isHttpsUrl(cover)) {
        return { ok: false, error: 'cover must be an https url' };
      }
      profile.cover = cover;
    }
  }

  for (const key of ['font', 'linkLayout'] as const) {
    const value = r[key];
    if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) continue;
    if (key === 'font') {
      if (!isHandleFont(value)) return { ok: false, error: `font must be one of ${HANDLE_FONTS.join(', ')}` };
      profile.font = value;
    } else {
      if (!isHandleLinkLayout(value)) return { ok: false, error: `linkLayout must be one of ${HANDLE_LINK_LAYOUTS.join(', ')}` };
      profile.linkLayout = value;
    }
  }

  if (r.socials !== undefined && r.socials !== null) {
    if (!Array.isArray(r.socials)) {
      return { ok: false, error: 'socials must be an array' };
    }
    if (r.socials.length > MAX_SOCIAL_LINKS) {
      return { ok: false, error: 'too many socials' };
    }
    const socials: string[] = [];
    for (const s of r.socials) {
      if (typeof s !== 'string') {
        return { ok: false, error: 'invalid social url' };
      }
      const url = s.trim();
      if (!url) return { ok: false, error: 'social url is required' };
      if (url.length > MAX_LINK_URL_LEN) {
        return { ok: false, error: 'social url too long' };
      }
      if (!isHttpsUrl(url)) {
        return { ok: false, error: 'social url must be https' };
      }
      socials.push(url);
    }
    if (socials.length > 0) profile.socials = socials;
  }

  if (r.links !== undefined && r.links !== null) {
    if (!Array.isArray(r.links)) return { ok: false, error: 'links must be an array' };
    if (r.links.length > MAX_PROFILE_LINKS) {
      return { ok: false, error: 'too many links' };
    }
    const links: HandleLink[] = [];
    // featured はプロフィール全体で最大 1 本。最初に featured=true を付けた 1 本だけを採用し、
    // 以降は無視する (サーバ検証でも enforce = クライアントを信用しない)。
    let featuredTaken = false;
    let embedCount = 0;
    for (const l of r.links) {
      if (typeof l !== 'object' || l === null || Array.isArray(l)) {
        return { ok: false, error: 'invalid link' };
      }
      const ll = l as Record<string, unknown>;
      const hasKind = Object.hasOwn(ll, 'kind');
      if (hasKind && ll.kind !== 'heading') {
        return { ok: false, error: 'unknown link kind' };
      }
      if (typeof ll.label !== 'string') {
        return { ok: false, error: 'invalid link' };
      }
      const label = ll.label.trim();
      if (!label) return { ok: false, error: 'link label is required' };
      if (label.length > MAX_LINK_LABEL_LEN) {
        return { ok: false, error: 'link label too long' };
      }
      if (ll.kind === 'heading') {
        // heading に通常リンク専用 field が存在する payload は値にかかわらず構造違反。
        if (Object.hasOwn(ll, 'url')) {
          return { ok: false, error: 'heading must not have url' };
        }
        if (Object.hasOwn(ll, 'featured')) {
          return { ok: false, error: 'heading must not be featured' };
        }
        if (Object.hasOwn(ll, 'imageUrl')) {
          return { ok: false, error: 'heading must not have image' };
        }
        if (Object.hasOwn(ll, 'embed')) {
          return { ok: false, error: 'heading must not be embedded' };
        }
        if (Object.hasOwn(ll, 'embedResolved')) {
          return { ok: false, error: 'heading must not have resolved embed' };
        }
        const heading: HandleHeading = { kind: 'heading', label };
        const emoji = sanitizeEmoji(ll.emoji);
        if (emoji) heading.emoji = emoji;
        links.push(heading);
        continue;
      }
      if (typeof ll.url !== 'string') {
        return { ok: false, error: 'invalid link' };
      }
      const url = ll.url.trim();
      if (url.length > MAX_LINK_URL_LEN) {
        return { ok: false, error: 'link url too long' };
      }
      if (!isHttpsUrl(url)) {
        return { ok: false, error: 'link url must be https' };
      }
      const link: HandleRegularLink = { label, url };
      // 絵文字は不正 (>2 code points 等) でも link 自体は残す (label/url を落とさない)。
      const emoji = sanitizeEmoji(ll.emoji);
      if (emoji) link.emoji = emoji;
      if (ll.featured === true && !featuredTaken) {
        link.featured = true;
        featuredTaken = true;
      }
      if (
        ll.imageUrl !== undefined &&
        ll.imageUrl !== null &&
        ll.imageUrl !== ''
      ) {
        if (typeof ll.imageUrl !== 'string') {
          return { ok: false, error: 'image must be string' };
        }
        const imageUrl = ll.imageUrl.trim();
        if (imageUrl) {
          if (imageUrl.length > MAX_LINK_IMAGE_URL_LEN) {
            return { ok: false, error: 'image url too long' };
          }
          if (!isHttpsUrl(imageUrl)) {
            return { ok: false, error: 'image must be an https url' };
          }
          link.imageUrl = imageUrl;
        }
      }
      if (ll.embed === true) {
        const embed = extractHandleEmbed(url, ll.embedResolved);
        if (!embed) {
          return { ok: false, error: 'embed not supported for this url' };
        }
        if (embedCount >= MAX_PROFILE_EMBEDS) {
          return { ok: false, error: 'too many embeds' };
        }
        link.embed = true;
        if (embed.provider === 'audius') {
          link.embedResolved = {
            provider: embed.provider,
            kind: embed.kind,
            id: embed.id,
          };
        }
        embedCount += 1;
      }
      links.push(link);
    }
    if (links.length > 0) profile.links = links;
  }

  // 着せ替えテーマ (enum のみ)。未知/不正は黙って落とす (= clean 扱い・エラーにしない)。
  if (isHandleTheme(r.theme)) profile.theme = r.theme;

  return { ok: true, profile };
}
