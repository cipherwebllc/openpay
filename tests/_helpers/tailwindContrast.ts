import tailwindColors from 'tailwindcss/colors';

// jsdom は CSS を当てないので、描いた DOM の class (Tailwind) から前景と背景を組み立て、WCAG 2.x の式でコントラスト比を出す。
// 色は node_modules の tailwindcss のパレットから読む。CSS をすべて真似るのではなく、扱える書き方だけを計算し、
// 扱えない書き方を見つけたら黙って飛ばさずに失敗に数える (fail closed・飛ばすと、読めない色や薄い文字がすり抜ける)。
//
// 扱う範囲:
// - 色: text-* / bg-* / ring-* の white・black・<色>-<濃さ> (パレットの色)。`/<整数>` の透明度。opacity-<整数>。
// - 大きさと太さ: text-xs〜9xl・text-[<数>px]・font-<太さ>。base と sm: / md: / lg: / xl: / 2xl: (画面の幅ごとに計算し、
//   いちばん厳しい幅の基準 = 小さい文字なら 4.5:1 で測る)。
// - ボタンの形: 不透明な bg-* か ring-<幅> + ring-<色> (base のみ)。
// - 状態: base (何もしていない)・hover (button / a とその祖先に hover:、hover された .group の子孫に group-hover:)・
//   focus (button / a に focus:、それが .group なら子孫に group-focus:)。disabled: は押せない要素にだけ当てる
//   (押せない要素の中の文字は 1.4.3 の対象外)。
// - SVG: 色は currentColor (継承した文字の色)。3:1 で測る。
//
// 扱わないので落とす書き方:
// - `!` 付き (important)・任意の CSS (`[color:#047857]` 等)・任意値の色 (`text-[#fff]`・`/[.85]`)・知らない色 (current・
//   transparent・inherit・brand 等)・text-opacity / bg-opacity・filter / backdrop / blend の class・線や塗りの色の class
//   (border-<色>・decoration-<色>・fill-*・stroke-* 等)・not-sr-only。
// - style 属性・color / opacity / fill-opacity / stroke-opacity / bgcolor 属性・currentColor と none 以外の fill / stroke 属性。
// - 扱わない variant (active・focus-visible・focus-within・peer-*・dark・任意の variant・2 つ以上の重ね等)。
//   大きさ・太さに付ける画面の幅以外の variant。ring の幅に付ける variant。
// - 同じ要素・同じ variant に同じ性質 (文字の色 2 つ等) の class が 2 つ (勝つのは class の順でなく CSS の順)。
// - 同じ要素で、同じ性質 (文字の色・地の色・opacity・ring) を違う値で上書きする variant が 2 つ以上 (group-hover と hover 等・
//   Tailwind の CSS の順はこの検査の順と違うことがある)。
// - button / a 以外の要素の hover: / focus: (その状態を試していない)。group-hover: / group-focus: は、.group の祖先が
//   すべて button / a のときだけ。
// - opacity-0 (どの variant でも)。例外は呼び出し側が `revealed` で指した要素 (CopyableField のコピーの案内) だけで、
//   その要素は .group の button の hover と focus のときに測られていなければならない。

type RGB = [number, number, number];
type RGBA = { rgb: RGB; a: number };
export type ContrastState = { kind: 'base' } | { kind: 'hover' | 'focus'; target: Element };
export type ContrastCheck = {
  state: string;
  kind: ContrastState['kind'];
  target?: Element;
  element: Element;
  text: string;
  ratio: number;
  need: number;
};
export type BoundaryCheck = { text: string; ratio: number };
export type AuditOptions = {
  /** opacity-0 を許す要素 (hover / focus で出る案内)。それ以外の opacity-0 は落とす。 */
  revealed?: (el: Element) => boolean;
};

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

type ColorProp = 'color' | 'bg' | 'ring';
type Decl = { prop: ColorProp; color: RGBA } | { prop: 'opacity' | 'ringWidth' | 'size' | 'weight'; value: number };

/** 1 つの utility を宣言に読む。コントラストに関係しないものは null、関係するのに扱えないものは 'unknown'。 */
function declOf(utility: string): Decl | null | 'unknown' {
  let m: RegExpMatchArray | null;
  if (utility.startsWith('!')) return 'unknown'; // important
  if (/^\[.*\]$/.test(utility)) return 'unknown'; // 任意の CSS ([color:#047857] 等)
  if (utility === 'not-sr-only') return 'unknown';
  if (/^-?(filter|invert|grayscale|sepia|blur|brightness|contrast|hue-rotate|saturate|drop-shadow|backdrop|mix-blend|bg-blend)(-|$)/.test(utility)) {
    return 'unknown';
  }
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

/** `a:b:c` を variant と utility に分ける (`[...]` の中の `:` では分けない)。 */
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

// 状態の variant (色・地・opacity・ring に使ってよいもの)。数字は重ねる順 (base が先)。同じ性質を違う値で上書きする variant が
// 2 つ以上あると scan で落とすので、variant 同士の順はこの検査の結果に効かない。
const STATE_VARIANTS: Record<string, number> = { '': 0, 'group-hover': 1, 'group-focus': 2, hover: 3, focus: 4, disabled: 5 };
// 画面の幅 (大きさ・太さにだけ使ってよい)。mobile-first: sm: は sm 以上の幅で当たる。
const BREAKPOINTS = ['', 'sm', 'md', 'lg', 'xl', '2xl'];

type Parsed = { token: string; variant: string; decl: Decl };
const classTokens = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
const parsedDecls = (el: Element): Parsed[] =>
  classTokens(el)
    .map((token) => ({ token, ...splitToken(token) }))
    .map(({ token, variants, utility }) => ({ token, variant: variants.join(':'), decl: declOf(utility) }))
    .filter((d): d is Parsed => d.decl !== null && d.decl !== 'unknown');
const groupAncestors = (el: Element) => {
  const out: Element[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) if (n.classList.contains('group')) out.push(n);
  return out;
};
const INTERACTIVE = 'button, a';

function applies(variant: string, el: Element, state: ContrastState): boolean {
  switch (variant) {
    case '':
      return true;
    case 'hover':
      return state.kind === 'hover' && el.contains(state.target);
    case 'focus':
      return state.kind === 'focus' && el === state.target;
    case 'group-hover':
      return state.kind === 'hover' && groupAncestors(el).some((g) => g.contains(state.target));
    case 'group-focus':
      return state.kind === 'focus' && groupAncestors(el).some((g) => g === state.target);
    case 'disabled':
      return el.matches(':disabled');
    default:
      return false;
  }
}

type Resolved = Partial<Record<ColorProp, RGBA> & Record<'opacity' | 'ringWidth', number>>;

/** 要素そのものの色・地・opacity・ring を、その状態で当たる variant の順に重ねる。 */
function resolve(el: Element, state: ContrastState): Resolved {
  const out: Resolved = {};
  const decls = parsedDecls(el)
    .filter((d) => d.decl.prop !== 'size' && d.decl.prop !== 'weight' && d.variant in STATE_VARIANTS)
    .sort((a, b) => STATE_VARIANTS[a.variant] - STATE_VARIANTS[b.variant]);
  for (const { variant, decl } of decls) {
    if (!applies(variant, el, state)) continue;
    if ('color' in decl) out[decl.prop] = decl.color;
    else if (decl.prop === 'opacity' || decl.prop === 'ringWidth') out[decl.prop] = decl.value;
  }
  return out;
}

/** 画面の幅 bp での要素そのものの大きさ・太さ (base と bp 以下の幅の variant)。 */
function typeAt(el: Element, bp: string): { size?: number; weight?: number } {
  const limit = BREAKPOINTS.indexOf(bp);
  const out: { size?: number; weight?: number } = {};
  const decls = parsedDecls(el)
    .filter((d) => (d.decl.prop === 'size' || d.decl.prop === 'weight') && BREAKPOINTS.includes(d.variant))
    .filter((d) => BREAKPOINTS.indexOf(d.variant) <= limit)
    .sort((a, b) => BREAKPOINTS.indexOf(a.variant) - BREAKPOINTS.indexOf(b.variant));
  for (const { decl } of decls) if (decl.prop === 'size' || decl.prop === 'weight') out[decl.prop] = decl.value;
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

/** 文字が小さい (4.5:1 が要る) 幅が 1 つでもあれば 4.5。24px 以上か 18.66px 以上の bold だけが大きな文字。 */
function needFor(chain: Element[]): number {
  const small = BREAKPOINTS.some((bp) => {
    let size: number | undefined;
    let weight: number | undefined;
    for (let i = chain.length - 1; i >= 0 && (size === undefined || weight === undefined); i -= 1) {
      const own = typeAt(chain[i], bp);
      size ??= own.size;
      weight ??= own.weight;
    }
    const px = size ?? 16;
    return !(px >= 24 || (px >= 18.66 && (weight ?? 400) >= 700));
  });
  return small ? 4.5 : 3;
}

/**
 * root (不透明な bg を持つ面) の中の文字・アイコン・ボタンの形を、1 つの状態で計算する。
 * - 文字: 4.5:1 (大きな文字は 3:1)。アイコン (svg): 3:1。押せない要素の中は 1.4.3 の対象外。
 * - 文字を opacity や text-<色>/NN で薄くしない。
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
  const inheritedColor = (chain: Element[]) => {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const v = resolve(chain[i], state).color;
      if (v) return v;
    }
    return undefined;
  };

  for (const el of [...root.querySelectorAll('*')]) {
    const isSvg = el.tagName.toLowerCase() === 'svg';
    const text = isSvg ? `[icon ${classTokens(el).find((c) => c.startsWith('lucide-')) ?? 'svg'}]` : directText(el);
    if (!text || el.closest('.sr-only')) continue;
    const chain = chainOf(el, root);
    const opacity = chain.reduce((p, n) => p * (resolve(n, state).opacity ?? 1), 1);
    if (opacity === 0) continue; // この状態では見えていない (opacity-0 を許すかは scan と auditAllStates で見る)
    const exempt = el.closest(':disabled') !== null;
    const fg = inheritedColor(chain);
    if (!fg) {
      failures.push(`[${label}] "${text}" の文字の色が読めない`);
      continue;
    }
    if (exempt) continue;
    if (opacity < 1 || fg.a < 1) failures.push(`[${label}] "${text}" が透明度で薄い (opacity ${opacity}・色 ${fg.a})`);
    const bg = background(chain);
    const ratio = contrastRatio(over({ rgb: fg.rgb, a: fg.a * opacity }, bg), bg);
    const need = isSvg ? 3 : needFor(chain);
    checked.push({
      state: label,
      kind: state.kind,
      target: state.kind === 'base' ? undefined : state.target,
      element: el,
      text,
      ratio,
      need,
    });
    if (ratio < need) failures.push(`[${label}] "${text}" ${ratio.toFixed(2)}:1 < ${need}:1`);
  }

  if (state.kind === 'base') {
    for (const el of [...root.querySelectorAll(INTERACTIVE)]) {
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

const COLOR_ATTRS = ['style', 'color', 'opacity', 'fill-opacity', 'stroke-opacity', 'bgcolor'];

/** 状態に依らない検査: 扱えない書き方 (冒頭の一覧) を見つけたら落とす。 */
export function scanClasses(root: Element, options: AuditOptions = {}): string[] {
  const failures: string[] = [];
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const where = (el.textContent ?? '').trim().slice(0, 20) || el.tagName.toLowerCase();
    for (const attr of COLOR_ATTRS) {
      if (el.hasAttribute(attr) && (attr !== 'style' || el.getAttribute('style')?.trim())) {
        failures.push(`扱えない属性: ${attr}="${el.getAttribute(attr)}" (${where})`);
      }
    }
    for (const attr of ['fill', 'stroke']) {
      const value = el.getAttribute(attr);
      if (value !== null && value !== 'currentColor' && value !== 'none') failures.push(`扱えない属性: ${attr}="${value}" (${where})`);
    }

    const tokens = classTokens(el);
    // 同じ要素・同じ variant に同じ種類 (文字の色 2 つ等) があると、勝つのは class の順でなく CSS の順で、この検査と食い違う。
    const seen = new Map<string, string>();
    // 性質ごとの、base 以外の variant が付ける値 (違う値が 2 つ以上なら落とす)。
    const overrides = new Map<string, Map<string, string>>();
    for (const token of tokens) {
      const { variants, utility } = splitToken(token);
      const decl = declOf(utility);
      if (decl === 'unknown') {
        failures.push(`扱えない class: ${token} (${where})`);
        continue;
      }
      if (!decl) continue;
      const variant = variants.join(':');
      const key = `${variant}|${decl.prop}`;
      const previous = seen.get(key);
      if (previous) failures.push(`同じ要素に同じ種類の class が 2 つ: ${previous} と ${token} (${where})`);
      seen.set(key, token);

      const isType = decl.prop === 'size' || decl.prop === 'weight';
      if (isType ? !BREAKPOINTS.includes(variant) : decl.prop === 'ringWidth' ? variant !== '' : !(variant in STATE_VARIANTS)) {
        failures.push(`扱えない variant: ${token} (${where})`);
        continue;
      }
      if (isType || decl.prop === 'ringWidth') continue;

      if (variant !== '') {
        const values = overrides.get(decl.prop) ?? new Map<string, string>();
        values.set(variant, JSON.stringify('color' in decl ? decl.color : decl.value));
        overrides.set(decl.prop, values);
      }
      if ((variant === 'hover' || variant === 'focus') && !el.matches(INTERACTIVE)) {
        failures.push(`button / a 以外の要素の ${variant}: (試していない状態): ${token} (${where})`);
      }
      if (variant === 'group-hover' || variant === 'group-focus') {
        const groups = groupAncestors(el);
        if (groups.length === 0 || groups.some((g) => !g.matches(INTERACTIVE))) {
          failures.push(`${variant}: の .group が button / a でない (試していない状態): ${token} (${where})`);
        }
      }
      if (decl.prop === 'opacity' && decl.value === 0 && !options.revealed?.(el)) {
        failures.push(`見えない文字 (opacity-0 は hover / focus で出る案内だけ): ${token} (${where})`);
      }
    }
    for (const [prop, values] of overrides) {
      if (new Set(values.values()).size > 1) {
        failures.push(`同じ性質 (${prop}) を違う値で上書きする variant が 2 つ以上: ${[...values.keys()].join(' / ')} (${where})`);
      }
    }
  }
  return failures;
}

/**
 * base と、root の中のすべての button / a の hover・focus をまとめて見る。`revealed` で指した要素 (opacity-0 を許す案内) は、
 * それを包む .group の button / a の hover と focus のときに測られていなければ落とす。
 */
export function auditAllStates(root: Element, options: AuditOptions = {}) {
  const states: ContrastState[] = [{ kind: 'base' }];
  for (const target of root.querySelectorAll(INTERACTIVE)) {
    states.push({ kind: 'hover', target }, { kind: 'focus', target });
  }
  const results = states.map((state) => auditState(root, state));
  const checked = results.flatMap((r) => r.checked);
  const failures = [...scanClasses(root, options), ...results.flatMap((r) => r.failures)];
  if (options.revealed) {
    for (const el of root.querySelectorAll('*')) {
      if (!options.revealed(el)) continue;
      const group = groupAncestors(el).find((g) => g.matches(INTERACTIVE));
      for (const kind of ['hover', 'focus'] as const) {
        if (!group || !checked.some((c) => c.element === el && c.kind === kind && c.target === group)) {
          failures.push(`案内 "${el.textContent?.trim()}" が ${kind} のときに測られていない (出ていない)`);
        }
      }
    }
  }
  return { failures, checked, boundaries: results.flatMap((r) => r.boundaries) };
}
