import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const globals = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');
const handlePage = readFileSync(
  resolve(process.cwd(), 'app/[locale]/[handle]/page.tsx'),
  'utf8',
);
const nightRuleStart = globals.indexOf('/* @handle の Night');
const nightCss = globals.slice(nightRuleStart);

afterEach(() => {
  document.head.querySelector('[data-test-night-css]')?.remove();
  document.body.replaceChildren();
});

describe('@handle night global footer CSS', () => {
  it('night marker のときだけ body + layout 直下 footer を dark にし、内部 footer は変えない', () => {
    expect(nightRuleStart).toBeGreaterThan(-1);
    expect(handlePage).toContain(
      "data-handle-theme={darkFooter ? 'night' : undefined}",
    );
    const style = document.createElement('style');
    style.dataset.testNightCss = '';
    style.textContent = nightCss;
    document.head.append(style);
    document.body.innerHTML = `
      <main data-handle-theme="night">
        <footer data-testid="profile-footer">Profile footer</footer>
      </main>
      <footer data-testid="global-footer"><a href="/terms">Terms</a></footer>
    `;

    const globalFooter = document.querySelector<HTMLElement>(
      '[data-testid="global-footer"]',
    )!;
    const profileFooter = document.querySelector<HTMLElement>(
      '[data-testid="profile-footer"]',
    )!;
    const globalLink = globalFooter.querySelector('a')!;
    expect(getComputedStyle(document.body).backgroundColor).toBe('rgb(2, 6, 23)');
    expect(getComputedStyle(globalFooter).backgroundColor).toBe('rgb(2, 6, 23)');
    expect(getComputedStyle(globalLink).color).toBe('rgb(203, 213, 225)');
    expect(getComputedStyle(profileFooter).backgroundColor).toBe(
      'rgba(0, 0, 0, 0)',
    );

    // night 以外のページを再現。:has が不成立になり、footer の computed style は既定へ戻る。
    document.querySelector('main')!.removeAttribute('data-handle-theme');
    expect(getComputedStyle(globalFooter).backgroundColor).toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(getComputedStyle(globalLink).color).not.toBe('rgb(203, 213, 225)');
  });
});
