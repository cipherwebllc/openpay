// カタログ/owned カードの見出しと本文の分離 (純関数)。
// JPYC 出品の多くは名前 (title) を持たず description だけなので、先頭文を見出しに昇格させ、
// 残りを本文に回す。名前を持つ商品 (first-party title / USDC 面の serviceName) は
// description を丸ごと本文にする。

export type DisplayTitleInput = {
  title?: string;
  description: string;
  resource: string;
  usdc?: { serviceName?: string };
};

/** 先頭文をそのまま見出しにできる上限。超えたら「名前」ではなく文章なので切り詰める。 */
const SENTENCE_AS_TITLE_MAX_CHARS = 120;
/** 切り詰め時の見出し長 (末尾 1 文字は「…」)。 */
const TRUNCATED_TITLE_CHARS = 48;

/** 見出しに使える区切り。日本語文中の「・」は句点がある文では語をつなぐ (技術調査・設計相談) ので切らない。 */
function separatorsFor(description: string): RegExp {
  return description.includes('。')
    ? /。|\. | — | – |: | \/ |：/
    : /。|\. | — | – |: | \/ |・|：/;
}

/** 本文が「名前: …」で始まるとき (Monitor 系の description) は見出しと重複する名前を落とす。 */
function stripLeadingName(description: string, name: string): string {
  const prefix = description.slice(0, name.length);
  if (prefix.toLowerCase() !== name.toLowerCase()) return description;
  const rest = description.slice(name.length);
  const stripped = rest.replace(/^\s*[:：—–-]\s*/, '');
  if (stripped === rest || !stripped) return description;
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * 見出し (title) と本文 (body) を返す。body は「見出しと重複しない残り」— 先頭文を見出しに
 * 昇格させたときは残りの文だけ、見出しが切り詰め (…) のときは全文、名前つき商品は全文。
 * 先頭文が長め (48〜120 字) でもそのまま見出しにし、表示側の line-clamp に任せる
 * (機械的に 47 字で切ると名前にならず本文と重複する)。
 */
export function splitDisplayTitle(input: DisplayTitleInput): { title: string; body: string } {
  const description = input.description.trim();
  const named = input.title || input.usdc?.serviceName;
  if (named) return { title: named, body: stripLeadingName(description, named) };

  const match = separatorsFor(description).exec(description);
  const firstSentence = (match ? description.slice(0, match.index) : description)
    .trim()
    // 文末の句点は見出しでは落とす (「…(curated JSON).」→「…(curated JSON)」)。
    .replace(/[.。]$/, '');
  const rest = (match ? description.slice(match.index + match[0].length) : '').trim();
  if (firstSentence) {
    const characters = Array.from(firstSentence);
    if (characters.length > SENTENCE_AS_TITLE_MAX_CHARS) {
      return {
        title: `${characters.slice(0, TRUNCATED_TITLE_CHARS - 1).join('')}…`,
        body: description,
      };
    }
    return { title: firstSentence, body: rest };
  }

  // description が空の出品 (server は必須にしているが表示は落とさない) は URL を見出しに。
  let fallback = input.resource;
  try {
    const url = new URL(input.resource);
    fallback = `${url.host}${url.pathname}`;
  } catch {
    /* 不正 URL は生文字列のまま (owned 一覧の入力途中値) */
  }
  return { title: fallback, body: '' };
}

/** 見出しだけが要る呼び元向け。 */
export function displayTitleOf(input: DisplayTitleInput): string {
  return splitDisplayTitle(input).title;
}
