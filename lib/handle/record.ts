// 保存済み record の正規化・parse・直列化と storefront 合成 (KV アクセスはしない)。
// 保存済みデータの tolerant な読み出しは、厳格な書き込み検証 (profile / tipConfig) と混ぜない。
import { TOKEN_SYMBOLS, DEFAULT_CHAIN_FOR_SYMBOL, type TokenSymbol } from '@/lib/tokens';
import type { ChainSlug } from '@/lib/chains';
import { validateStorefrontParts, validateOrderConfig, type MobileOrderConfig } from '@/lib/mobileOrder';
import { isHandleTheme } from '@/lib/handleThemeKey';
import { extractHandleEmbed } from './embeds';
import {
  MAX_BIO_LEN, MAX_AVATAR_URL_LEN, MAX_COVER_URL_LEN, MAX_SOCIAL_LINKS,
  MAX_LINK_URL_LEN, MAX_PROFILE_LINKS, MAX_LINK_LABEL_LEN, MAX_LINK_IMAGE_URL_LEN,
  MAX_PROFILE_EMBEDS, isHandleFont, isHandleLinkLayout, isHttpsUrl, sanitizeEmoji,
  type HandleRecord, type HandleTipConfig, type HandleReceiveMethod,
  type HandleProfile, type HandleLink, type HandleHeading, type HandleRegularLink,
} from './schema';

/**
 * handle レコード + 保存済み storefront → 顧客向け MobileOrderConfig (無ければ null)。
 * identity は handle 由来: receiver=config.to / shopName=config.name||@handle /
 * avatar=profile.avatar / socials=profile.socials。最終検証は validateOrderConfig に委譲
 * (storefront と公開ページの単一情報源)。受取先などが不正なら null。
 */
export function handleStorefrontConfig(
  record: HandleRecord,
  handle: string,
): MobileOrderConfig | null {
  const sf = record.storefront;
  if (!sf) return null;
  // ブランディングは storefront (ビルダー由来) を優先し、無ければ @handle 側へフォールバック。
  // 受取先 (receiver) は @handle が権威 (config.to)。
  return validateOrderConfig({
    receiver: record.config.to,
    chain: sf.chain,
    chains: sf.chains, // 受取チェーン集合 (2 件以上で注文ページに選択 UI)
    shopName: sf.shopName || record.config.name?.trim() || `@${handle}`,
    tagline: sf.tagline, // 店名下のひとこと (ビルダー由来のみ・任意・validateOrderConfig が再検証)
    accent: record.config.color, // テーマ色 = @handle のプロフィール色を店舗ページにも適用 (validateOrderConfig が再検証)
    avatar: sf.avatar ?? record.profile?.avatar,
    cover: sf.cover, // 店舗カバー画像 (storefront 専用・validateOrderConfig が再検証)
    mode: sf.mode,
    feePayer: sf.feePayer,
    socials: sf.socials ?? record.profile?.socials ?? [],
    menu: sf.menu,
    // 店舗情報 (任意)。storefront に保存された値をそのまま公開ページへ (validateOrderConfig が再検証)。
    address: sf.address,
    hours: sf.hours,
    phone: sf.phone,
    acceptingOrders: sf.acceptingOrders,
    dineIn: sf.dineIn, // 提供形態 (店内ならテーブル番号入力・validateOrderConfig が再検証)
    // 時間系 (任意)。@handle 公開ページも self-contained 注文 URL と同じ受付制御を使う。
    openFrom: sf.openFrom,
    lastOrder: sf.lastOrder,
    minLeadMinutes: sf.minLeadMinutes,
  });
}

const STRING_KEYS = [
  'name',
  'message',
  'color',
  'thanks',
  'thanksUrl',
  'webhook',
] as const;

// token 別 presets を構造のみ検証 (旧形 = 単一 string[] / 新形 = token→string[])。
function normalizeStoredPresets(
  raw: unknown,
  fallbackToken: TokenSymbol,
): Partial<Record<TokenSymbol, string[]>> | undefined {
  if (Array.isArray(raw)) {
    // 旧 single-config: presets は単一 token のリスト → その token に割当。
    const arr = raw.filter((p): p is string => typeof p === 'string');
    return arr.length > 0 ? { [fallbackToken]: arr } : undefined;
  }
  if (raw && typeof raw === 'object') {
    const pin = raw as Record<string, unknown>;
    const out: Partial<Record<TokenSymbol, string[]>> = {};
    for (const tok of TOKEN_SYMBOLS) {
      if (Array.isArray(pin[tok])) {
        const arr = (pin[tok] as unknown[]).filter(
          (p): p is string => typeof p === 'string',
        );
        if (arr.length > 0) out[tok] = arr;
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

// KV JSON の config を HandleTipConfig へ構造検証 + 旧 single-config を migration。
// 新形 = { to, methods:[{token,chain,crossChain?}], presets:{token→[]} }。
// 旧形 = { to, token, chain?, crossChain?, presets:[] } → methods:[1件] へ畳む。
// 意味的整合 (gasless 等) は呼出側が methodToPublishableConfig + parseTipParams で再検証する。
function normalizeStoredConfig(raw: unknown): HandleTipConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.to !== 'string') return null;
  for (const k of STRING_KEYS) {
    if (c[k] !== undefined && typeof c[k] !== 'string') return null;
  }

  let methods: HandleReceiveMethod[];
  let presetFallbackToken: TokenSymbol;

  if (Array.isArray(c.methods)) {
    const parsed: HandleReceiveMethod[] = [];
    for (const m of c.methods) {
      if (typeof m !== 'object' || m === null) return null;
      const mm = m as Record<string, unknown>;
      if (typeof mm.token !== 'string' || typeof mm.chain !== 'string') {
        return null;
      }
      if (mm.crossChain !== undefined && typeof mm.crossChain !== 'boolean') {
        return null;
      }
      parsed.push({
        token: mm.token as TokenSymbol,
        chain: mm.chain as ChainSlug,
        crossChain: mm.crossChain as boolean | undefined,
      });
    }
    if (parsed.length === 0) return null;
    methods = parsed;
    presetFallbackToken = parsed[0].token;
  } else if (typeof c.token === 'string') {
    // 旧 single-config を migration。
    if (c.chain !== undefined && typeof c.chain !== 'string') return null;
    if (c.crossChain !== undefined && typeof c.crossChain !== 'boolean') {
      return null;
    }
    const token = c.token as TokenSymbol;
    const chain = (
      typeof c.chain === 'string' ? c.chain : DEFAULT_CHAIN_FOR_SYMBOL[token]
    ) as ChainSlug;
    methods = [
      {
        token,
        chain,
        crossChain: typeof c.crossChain === 'boolean' ? c.crossChain : undefined,
      },
    ];
    presetFallbackToken = token;
  } else {
    return null;
  }

  return {
    to: c.to,
    name: c.name as string | undefined,
    message: c.message as string | undefined,
    color: c.color as string | undefined,
    ...(isHandleTheme(c.theme) ? { theme: c.theme } : {}),
    thanks: c.thanks as string | undefined,
    thanksUrl: c.thanksUrl as string | undefined,
    webhook: c.webhook as string | undefined,
    methods,
    presets: normalizeStoredPresets(c.presets, presetFallbackToken),
  };
}

// KV JSON の profile を寛容に読む (読み取り経路)。壊れたフィールドは個別に落とし、
// 有効な分だけ返す (profile の破損で @handle の tip 全体が落ちないようにする)。書込側の
// validateProfile は厳格 (error) だが、読込側は best-effort で可用性を優先する。
function parseStoredProfile(raw: unknown): HandleProfile | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const profile: HandleProfile = {};
  if (typeof r.bio === 'string') {
    const bio = r.bio.trim();
    if (bio) profile.bio = bio.slice(0, MAX_BIO_LEN);
  }
  if (typeof r.avatar === 'string') {
    const avatar = r.avatar.trim();
    if (avatar && avatar.length <= MAX_AVATAR_URL_LEN && isHttpsUrl(avatar)) {
      profile.avatar = avatar;
    }
  }
  if (typeof r.cover === 'string') {
    const cover = r.cover.trim();
    if (cover && cover.length <= MAX_COVER_URL_LEN && isHttpsUrl(cover)) {
      profile.cover = cover;
    }
  }
  if (isHandleFont(r.font)) profile.font = r.font;
  if (isHandleLinkLayout(r.linkLayout)) profile.linkLayout = r.linkLayout;
  if (Array.isArray(r.socials)) {
    const socials: string[] = [];
    for (const s of r.socials) {
      if (socials.length >= MAX_SOCIAL_LINKS) break;
      if (typeof s !== 'string') continue;
      const url = s.trim();
      if (!url || url.length > MAX_LINK_URL_LEN || !isHttpsUrl(url)) continue;
      socials.push(url);
    }
    if (socials.length > 0) profile.socials = socials;
  }
  if (Array.isArray(r.links)) {
    const links: HandleLink[] = [];
    let featuredTaken = false;
    let embedCount = 0;
    for (const l of r.links) {
      if (links.length >= MAX_PROFILE_LINKS) break;
      if (typeof l !== 'object' || l === null || Array.isArray(l)) continue;
      const ll = l as Record<string, unknown>;
      const hasKind = Object.hasOwn(ll, 'kind');
      if (hasKind && ll.kind !== 'heading') continue;
      if (typeof ll.label !== 'string') continue;
      const label = ll.label.trim();
      if (!label) continue;
      if (ll.kind === 'heading') {
        // 壊れた heading だけを落とし、後続の正常なリンク/featured へ波及させない。
        if (
          Object.hasOwn(ll, 'url') ||
          Object.hasOwn(ll, 'featured') ||
          Object.hasOwn(ll, 'imageUrl') ||
          Object.hasOwn(ll, 'embed') ||
          Object.hasOwn(ll, 'embedResolved')
        ) {
          continue;
        }
        const heading: HandleHeading = {
          kind: 'heading',
          label: label.slice(0, MAX_LINK_LABEL_LEN),
        };
        const emoji = sanitizeEmoji(ll.emoji);
        if (emoji) heading.emoji = emoji;
        links.push(heading);
        continue;
      }
      if (typeof ll.url !== 'string') continue;
      const url = ll.url.trim();
      if (url.length > MAX_LINK_URL_LEN || !isHttpsUrl(url)) continue;
      const link: HandleRegularLink = {
        label: label.slice(0, MAX_LINK_LABEL_LEN),
        url,
      };
      const emoji = sanitizeEmoji(ll.emoji);
      if (emoji) link.emoji = emoji;
      // featured は最大 1 本 (書込側で enforce 済みだが読込側も冪等に守る)。
      if (ll.featured === true && !featuredTaken) {
        link.featured = true;
        featuredTaken = true;
      }
      if (typeof ll.imageUrl === 'string') {
        const imageUrl = ll.imageUrl.trim();
        if (
          imageUrl &&
          imageUrl.length <= MAX_LINK_IMAGE_URL_LEN &&
          isHttpsUrl(imageUrl)
        ) {
          link.imageUrl = imageUrl;
        }
      }
      const embed =
        ll.embed === true
          ? extractHandleEmbed(url, ll.embedResolved)
          : null;
      if (embed && embedCount < MAX_PROFILE_EMBEDS) {
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
  // 着せ替えテーマ (enum のみ)。未知は落とす (clean 扱い)。
  if (isHandleTheme(r.theme)) profile.theme = r.theme;
  return Object.keys(profile).length > 0 ? profile : undefined;
}

// KV JSON → HandleRecord の型ガード。config は構造のみ検証 + 旧形 migration、profile は
// 寛容に読む (token/chain の意味的整合は呼出側が parseTipParams で再検証する)。malformed は null。
export function parseHandleRecord(json: string | null): HandleRecord | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (
    typeof rec.owner !== 'string' ||
    typeof rec.createdAt !== 'number' ||
    typeof rec.updatedAt !== 'number'
  ) {
    return null;
  }
  const config = normalizeStoredConfig(rec.config);
  if (!config) return null;
  const profile = parseStoredProfile(rec.profile);
  // storefront も寛容に読む (壊れていれば店舗無し扱い・@handle の tip/profile は落とさない)。
  // 検証規則は mobileOrder と単一情報源 (validateStorefrontParts)。
  const storefront = validateStorefrontParts(rec.storefront);
  const record: HandleRecord = {
    owner: rec.owner,
    config,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (profile) record.profile = profile;
  if (storefront) record.storefront = storefront;
  return record;
}

export function serializeHandleRecord(record: HandleRecord): string {
  return JSON.stringify(record);
}
