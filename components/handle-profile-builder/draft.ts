// 公開中のレコードから HandleProfileBuilder の下書きを組み直す純関数。状態は持たない。

import { COLOR_PATTERN } from '@/lib/url';
import { DEFAULT_PROFILE_DRAFT, type HandleProfileDraft } from '@/hooks/useHandleProfileDraft';
import type { HandleProfile, HandleTipConfig } from '@/lib/handle';

function stripResolvedEmbedsForDraft(
  links: HandleProfile['links'],
): NonNullable<HandleProfile['links']> {
  return (links ?? []).map((link) => {
    if (link.kind === 'heading') return link;
    const draftLink = { ...link };
    delete draftLink.embedResolved;
    return draftLink;
  });
}

/** 公開中のレコードから下書きを組み直す (編集に入るとき・下書きが公開中と同じかを確かめるとき)。
 *  USDC は flag に依らず chain ごとに復元し、公開済み Arc を Base に置き換えない。
 *  編集対象レコードに無いフィールドは「前の下書き値」ではなく **builder 既定**へ戻す。
 *  でないと別プロフィールの色/プリセットが update 時にこの handle へ混入する。 */
export function draftFromPublished(c: HandleTipConfig, p?: HandleProfile): HandleProfileDraft {
  return {
    to: c.to,
    name: c.name ?? '',
    message: c.message,
    thanks: c.thanks,
    thanksUrl: c.thanksUrl,
    color:
      c.color && COLOR_PATTERN.test(c.color)
        ? c.color
        : DEFAULT_PROFILE_DRAFT.color,
    jpycPolygon: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'polygon'),
    jpycKaia: c.methods.some((m) => m.token === 'jpyc' && m.chain === 'kaia'),
    jpycAvalanche: c.methods.some(
      (m) => m.token === 'jpyc' && m.chain === 'avalanche',
    ),
    usdcBase: c.methods.some((m) => m.token === 'usdc' && m.chain === 'base'),
    usdcArc: c.methods.some((m) => m.token === 'usdc' && m.chain === 'arc'),
    presetsJpyc: c.presets?.jpyc ?? DEFAULT_PROFILE_DRAFT.presetsJpyc,
    bio: p?.bio ?? '',
    avatar: p?.avatar ?? '',
    cover: p?.cover ?? '',
    font: p?.font ?? DEFAULT_PROFILE_DRAFT.font,
    linkLayout: p?.linkLayout ?? DEFAULT_PROFILE_DRAFT.linkLayout,
    socials: p?.socials ?? [],
    links: stripResolvedEmbedsForDraft(p?.links),
    theme: p?.theme ?? DEFAULT_PROFILE_DRAFT.theme,
  };
}
