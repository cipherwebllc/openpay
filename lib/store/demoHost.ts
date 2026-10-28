/** demoUrl のホスト名 (表示用)。保存時に https 検証済みだが、壊れた値で描画を落とさない。 */
export function demoHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}
