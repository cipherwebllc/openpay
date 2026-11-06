import tailwindColors from 'tailwindcss/colors';

// jsdom は CSS を当てないので、描いた DOM の class (Tailwind) から前景と背景を組み立て、WCAG 2.x の式でコントラスト比を出す。
// 色は node_modules の tailwindcss のパレットから読む。読めない class (任意値・知らない色・扱えない variant) は黙って飛ばさず
// 失敗に数える (飛ばすと、薄い文字や読めない色をこの検査がすり抜ける)。
// 状態: base (何もしていない)・hover (要素とその祖先に hover: を当て、hover された .group の子孫に group-hover: を当てる)・
// focus (要素に focus: を当て、その要素が .group なら子孫に group-focus: を当てる)。disabled: は押せない要素にだけ当てる。

type RGB = [number, number, number];
type RGBA = { rgb: RGB; a: number };
export type ContrastState = { kind: 'base' } | { kind: 'hover' | 'focus'; target: Element };
export type ContrastCheck = { state: string; text: string; ratio: number; need: number };
export type BoundaryCheck = { text: string; ratio: number };

const palette = tailwindColors as unknown as Record<string, unknown>;
const WHITE: RGB = [255, 255, 255];

function hexToRgb(hex: string): RGB | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as RGB;
}

const luminance = (c: RGB) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export function contrastRatio(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const over = (fg: RGBA, bg: RGB): RGB => fg.rgb.map((v, i) => v * fg.a + bg[i] * (1 - fg.a)) as RGB;

/** `white`・`black`・`<色>-<濃さ>` と、任意で `/<整数>` の透明度。それ以外 (任意値 `[#fff]`・`/[.85]`・知らない色) は null。 */
function parseColor(spec: string): RGBA | null {
  const [name, alpha, ...rest] = spec.split('/');
  if (rest.length > 0) return null;
  let rgb: RGB | null = null;
  if (name === 'white') rgb = WHITE;
  else if (name === 'black') rgb = [0, 0, 0];
  else {
    const m = name.match(/^([a-z]+)-(\d{2,3})$/);
    const family = m ? palette[m[1]] : undefined;
    const value = m && family && typeof family === 'object' ? (family as Record<string, unknown>)[m[2]] : undefined;
    rgb = typeof value === 'string' ? hexToRgb(value) : null;
  }
  if (!rgb) return null;
  if (alpha === undefined) return { rgb, a: 1 };
  return /^\d+$/.test(alpha) ? { rgb, a: Number(alpha) / 100 } : null;
}

const TEXT_SIZES: Record<string, number> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36, '5xl': 48, '6xl': 60, '7xl': 72, '8xl': 96, '9xl': 128,
};
// 色でも大きさでもない text-* (揃え・折り返し)。
const TEXT_OTHER = new Set(['left', 'center', 'right', 'justify', 'start', 'end', 'ellipsis', 'clip', 'wrap', 'nowrap', 'balance', 'pretty']);
const WEIGHTS: Record<string, number> = {
  thin: 100, extralight: 200, light: 300, normal: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900,
};

type Decl =
  | { prop: 'color' | 'bg' | 'ring'; color: RGBA }
  | { prop: 'opacity' | 'ringWidth' | 'size' | 'weight'; value: number };

/** 1 つの utility を宣言に読む。コントラストに関係しないものは null、関係するのに読めないものは 'unknown'。 */
function declOf(utility: string): Decl | null | 'unknown' {
  let m: RegExpMatchArray | null;
  if ((m = utility.match(/^text-(.+)$/))) {
    const v = m[1];
    if (v in TEXT_SIZES) return { prop: 'size', value: TEXT_SIZES[v] };
    if (TEXT_OTHER.has(v)) return null;
    const px = v.match(/^\[(\d+(?:\.\d+)?)px\]$/);
    if (px) return { prop: 'size', value: Number(px[1]) };
    const color = parseColor(v);
    return color ? { prop: 'color', color } : 'unknown';
  }
  if ((m = utility.match(/^bg-(.+)$/))) {
    const color = parseColor(m[1]);
    return color ? { prop: 'bg', color } : 'unknown';
  }
  if ((m = utility.match(/^opacity-(.+)$/))) return /^\d+$/.test(m[1]) ? { prop: 'opacity', value: Number(m[1]) / 100 } : 'unknown';
  if (utility === 'ring') return { prop: 'ringWidth', value: 3 };
  if ((m = utility.match(/^ring-(\d+)$/))) return { prop: 'ringWidth', value: Number(m[1]) };
  if (utility === 'ring-inset') return null;
  if ((m = utility.match(/^ring-(.+)$/))) {
    const color = parseColor(m[1]);
    return color ? { prop: 'ring', color } : 'unknown';
  }
  if ((m = utility.match(/^font-(.+)$/))) return m[1] in WEIGHTS ? { prop: 'weight', value: WEIGHTS[m[1]] } : null;
  // 線の太さ・影は比に関係しない。線や塗りの色 (decoration-<色>・border-<色>・fill/stroke 等) はこの検査が読まないので落とす。
  if (/^decoration-(\d+|auto|from-font|solid|double|dotted|dashed|wavy)$/.test(utility)) return null;
  if (/^shadow(-.+)?$/.test(utility)) return null;
  if (/^(border|outline|divide)(-[xytrblse])?(-\d+)?$/.test(utility)) return null;
  if (/^(decoration|border|outline|divide|fill|stroke|from|via|to|caret|accent|placeholder)-/.test(utility)) return 'unknown';
  return null;
}

/** `a:b:c` を variant と utility に分ける (`[word-break:auto-phrase]` の中の `:` では分けない)。 */
function splitToken(token: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of token) {
    if (ch === '[') depth += 1;
    if (ch === ']') depth -= 1;
    if (ch === ':' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return { variants: parts.slice(0, -1), utility: parts[parts.length - 1] };
}

const VARIANT_RANK: Record<string, number> = { '': 0, 'group-hover': 1, 'group-focus': 2, hover: 3, focus: 4, disabled: 5 };
const classTokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const groupAncestor = (el: Element, test: (g: Element) => boolean) => {
  for (let n = el.parentElement; n; n = n.parentElement) if (n.classList.contains('group') && test(n)) return true;
  return false;
};

function applies(variant: string, el: Element, state: ContrastState): boolean {
  switch (variant) {
    case '':
      return true;
    case 'hover':
      return state.kind === 'hover' && el.contains(state.target);
    case 'focus':
      return state.kind === 'focus' && el === state.target;
    case 'group-hover':
      return state.kind === 'hover' && groupAncestor(el, (g) => g.contains(state.target));
    case 'group-focus':
      return state.kind === 'focus' && groupAncestor(el, (g) => g === state.target);
    case 'disabled':
      return el.matches(':disabled');
    default:
      return false;
  }
}

type Resolved = Partial<Record<'color' | 'bg' | 'ring', RGBA> & Record<'opacity' | 'ringWidth' | 'size' | 'weight', number>>;

/** 要素そのものの宣言を、その状態で当たる variant の順 (Tailwind の CSS の順) に重ねる。 */
function resolve(el: Element, state: ContrastState): Resolved {
  const out: Resolved = {};
  const decls = classTokens(el)
    .map(splitToken)
    .map(({ variants, utility }) => ({ variant: variants.join(':'), decl: declOf(utility) }))
    .filter((d): d is { variant: string; decl: Decl } => d.decl !== null && d.decl !== 'unknown')
    // sm: 等の画面幅の variant は大きさにだけ使っている (色の variant は scan で落とす)。大きな文字の判定は狭い画面の大きさで見る。
    .filter((d) => d.variant in VARIANT_RANK)
    .sort((a, b) => VARIANT_RANK[a.variant] - VARIANT_RANK[b.variant]);
  for (const { variant, decl } of decls) {
    if (!applies(variant, el, state)) continue;
    if ('color' in decl) out[decl.prop] = decl.color;
    else out[decl.prop] = decl.value;
  }
  return out;
}

function chainOf(el: Element, root: Element): Element[] {
  const chain: Element[] = [];
  for (let n: Element | null = el; n; n = n.parentElement) {
    chain.unshift(n);
    if (n === root) return chain;
  }
  throw new Error('root の外の要素');
}

const directText = (el: Element) =>
  [...el.childNodes]
    .filter((n) => n.nodeType === 3)
    .map((n) => n.textContent?.trim() ?? '')
    .filter(Boolean)
    .join(' ');

export function stateLabel(state: ContrastState): string {
  if (state.kind === 'base') return 'base';
  const name = (state.target.getAttribute('aria-label') || state.target.textContent || '').trim().slice(0, 24);
  return `${state.kind}:${name}`;
}

/**
 * root (不透明な bg を持つ面) の中の文字・アイコン・ボタンの形を、1 つの状態で計算する。
 * - 文字: 4.5:1 (24px 以上か 18.66px 以上の bold は 3:1)。アイコン (svg): 3:1。押せない要素の中は 1.4.3 の対象外。
 * - 文字を opacity や text-<色>/NN で薄くしない。opacity-0 は、hover / focus で出るコピーの案内だけ (group-hover と group-focus で 100)。
 * - ボタンの形 (不透明な地か ring) は、後ろとの境目が 3:1 (base のときだけ・hover の地は形ではなく押した印)。rounded-full / rounded-xl の
 *   文字のボタンは形が要る。
 */
export function auditState(root: Element, state: ContrastState) {
  const failures: string[] = [];
  const checked: ContrastCheck[] = [];
  const boundaries: BoundaryCheck[] = [];
  const label = stateLabel(state);

  const rootBg = resolve(root, state).bg;
  if (!rootBg || rootBg.a !== 1) {
    failures.push(`[${label}] root の地が不透明な色でない`);
    return { failures, checked, boundaries };
  }
  const background = (chain: Element[]): RGB =>
    chain.slice(1).reduce<RGB>((bg, n) => {
      const own = resolve(n, state).bg;
      return own ? over(own, bg) : bg;
    }, rootBg.rgb);
  const inherited = <K extends 'color' | 'size' | 'weight'>(chain: Element[], key: K) => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const v = resolve(chain[i], state)[key];
      if (v !== undefined) return v as Resolved[K];
    }
    return undefined;
  };

  for (const el of [...root.querySelectorAll('*')]) {
    const isSvg = el.tagName.toLowerCase() === 'svg';
    const text = isSvg ? `[icon ${classTokens(el).find((c) => c.startsWith('lucide-')) ?? 'svg'}]` : directText(el);
    if (!text || el.closest('.sr-only')) continue;
    const chain = chainOf(el, root);
    const opacity = chain.reduce((p, n) => p * (resolve(n, state).opacity ?? 1), 1);
    if (opacity === 0) continue; // この状態では見えていない (opacity-0 を許すかは scan で見る)
    const exempt = el.closest(':disabled') !== null;
    const fg = inherited(chain, 'color');
    if (!fg) {
      failures.push(`[${label}] "${text}" の文字の色が読めない`);
      continue;
    }
    if (!exempt && (opacity < 1 || fg.a < 1)) failures.push(`[${label}] "${text}" が透明度で薄い (opacity ${opacity}・色 ${fg.a})`);
    const bg = background(chain);
    const ratio = contrastRatio(over({ rgb: fg.rgb, a: fg.a * opacity }, bg), bg);
    const size = inherited(chain, 'size') ?? 16;
    const weight = inherited(chain, 'weight') ?? 400;
    const need = isSvg || size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5;
    if (exempt) continue;
    checked.push({ state: label, text, ratio, need });
    if (ratio < need) failures.push(`[${label}] "${text}" ${ratio.toFixed(2)}:1 < ${need}:1`);
  }

  if (state.kind === 'base') {
    for (const el of [...root.querySelectorAll('button, a')]) {
      if (el.matches(':disabled')) continue;
      const chain = chainOf(el, root);
      const behind = background(chain.slice(0, -1));
      const own = resolve(el, state);
      const name = (el.textContent ?? '').trim();
      const indicators: number[] = [];
      if (own.bg && own.bg.a === 1) indicators.push(contrastRatio(own.bg.rgb, behind));
      if (own.ringWidth) {
        if (!own.ring) failures.push(`"${name}" の ring に色が無い (Tailwind の既定の半透明の青になる)`);
        else indicators.push(contrastRatio(over(own.ring, behind), behind));
      }
      const shaped = name !== '' && classTokens(el).some((c) => c === 'rounded-full' || c === 'rounded-xl');
      if (indicators.length === 0) {
        if (shaped && own.ringWidth === undefined) failures.push(`"${name}" はボタンの形 (不透明な地か ring) が無い`);
        continue;
      }
      const ratio = Math.max(...indicators);
      boundaries.push({ text: name, ratio });
      if (ratio < 3) failures.push(`"${name}" の形と後ろの境目 ${ratio.toFixed(2)}:1 < 3:1`);
    }
  }
  return { failures, checked, boundaries };
}

/** 状態に依らない検査: 読めない class・扱えない variant・同じ要素の同じ種類の重なり・見えない文字 (opacity-0)。 */
export function scanClasses(root: Element): string[] {
  const failures: string[] = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const tokens = classTokens(el);
    // 同じ要素・同じ variant に同じ種類 (文字の色 2 つ等) があると、勝つのは class の順でなく CSS の順で、この検査と食い違う。
    const seen = new Map<string, string>();
    for (const token of tokens) {
      const { variants, utility } = splitToken(token);
      const decl = declOf(utility);
      const where = (el.textContent ?? '').trim().slice(0, 20);
      if (decl === 'unknown') {
        failures.push(`読めない class: ${token} (${where})`);
        continue;
      }
      if (!decl) continue;
      const variant = variants.join(':');
      const key = `${variant}|${decl.prop}`;
      const previous = seen.get(key);
      if (previous) failures.push(`同じ要素に同じ種類の class が 2 つ: ${previous} と ${token} (${where})`);
      seen.set(key, token);
      const isLayout = decl.prop === 'size' || decl.prop === 'weight' || decl.prop === 'ringWidth';
      if (!(variant in VARIANT_RANK) && !(isLayout && variants.every((v) => /^(sm|md|lg|xl|2xl)$/.test(v)))) {
        failures.push(`扱えない variant: ${token} (${where})`);
      }
      if (decl.prop === 'opacity' && decl.value === 0 && variant === '') {
        const revealed = tokens.includes('group-hover:opacity-100') && tokens.includes('group-focus:opacity-100');
        if (!revealed || !groupAncestor(el, () => true)) failures.push(`見えない文字 (opacity-0): ${where || token}`);
      }
    }
  }
  return failures;
}

/** base と、root の中のすべての button / a の hover・focus をまとめて見る。 */
export function auditAllStates(root: Element) {
  const states: ContrastState[] = [{ kind: 'base' }];
  for (const target of root.querySelectorAll('button, a')) {
    states.push({ kind: 'hover', target }, { kind: 'focus', target });
  }
  const results = states.map((state) => auditState(root, state));
  return {
    failures: [...scanClasses(root), ...results.flatMap((r) => r.failures)],
    checked: results.flatMap((r) => r.checked),
    boundaries: results.flatMap((r) => r.boundaries),
  };
}
