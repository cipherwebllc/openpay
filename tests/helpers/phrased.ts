// 文節の区切りを入れた文 (components/Phrased.tsx) を、文字で探すテストのための小さな helper。
// 区切りを入れた文は <span class="phrased">塊<wbr>塊…</span> に包まれる。getByText は文字を直接持つ要素 = その span を返すので、
// 「文を置いた要素 (p・h3 など) の class」を見るテストは、span の親を見る。区切りの無い文 (塊が 1 つ・en) は包まれないので、
// getByText が返した要素がそのまま文を置いた要素。

/** 文を置いた要素。getByText が区切りの span を返したときは、その親。 */
export function textHolder(el: HTMLElement): HTMLElement {
  return el.classList.contains('phrased') && el.parentElement ? el.parentElement : el;
}
