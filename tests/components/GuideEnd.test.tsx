// ガイドの末尾 (components/guide/GuideEnd.tsx): 行動の帯 (GuideCta) と関連ガイドの 1 行 (GuideRelated)。
// 見出しは「このページの内容」に載せない (data-toc="skip")・関連ガイドは「前へ / 次へ」と同じ行き先を重ねない・aria-label を使わない (掟 8)。

import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { GuideCta, GuideRelated } from '@/components/guide/GuideEnd';

describe('GuideCta', () => {
  it('見出し・一文・ボタン (内部は Link・http は a)・下段の補足', () => {
    const { container, rerender } = render(
      <GuideCta title="まずは試してみる" action={{ href: '/ja/create', label: '決済QRを作る' }} footer={<p>補足の行</p>}>
        <p>一文の説明</p>
      </GuideCta>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'まずは試してみる' });
    expect(heading).toHaveAttribute('data-toc', 'skip');
    expect(screen.getByText('一文の説明')).toBeInTheDocument();
    expect(screen.getByText('補足の行')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '決済QRを作る' })).toHaveAttribute('href', '/ja/create');
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0);

    rerender(<GuideCta title="試す" action={{ href: 'https://open-pay.jp/@openpay_test', label: '開く' }} />);
    expect(screen.getByRole('link', { name: '開く' })).toHaveAttribute('href', 'https://open-pay.jp/@openpay_test');
  });
});

describe('GuideRelated', () => {
  it('目次と同じ名前で並べ、「前へ / 次へ」と同じ行き先は出さない', () => {
    // /guide/pos の前へ = shop・次へ = ハブ (お店向けの最後)。
    render(
      <GuideRelated
        locale="ja"
        current="pos"
        links={['start', 'shop', 'pricing', { href: '/ja/guide/qr#jpyc-discount', label: 'JPYC 払いで割引する' }]}
      />,
    );
    // 見出しと名前は目次 (guideNav) と同じ・shop は「前へ」と同じなので出さない。
    const section = screen.getByRole('heading', { level: 2, name: '関連ガイド' }).closest('section')!;
    expect(within(section).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['導入前チェックリスト', '/ja/guide/start'],
      ['料金', '/ja/pricing'],
      ['JPYC 払いで割引する', '/ja/guide/qr#jpyc-discount'],
    ]);
    expect(screen.getByRole('heading', { level: 2, name: '関連ガイド' })).toHaveAttribute('data-toc', 'skip');
  });

  it('残りが無ければ何も出さない', () => {
    // /guide/wallet の前へ = pay・次へ = mobile-order。
    const { container } = render(
      <GuideRelated
        locale="ja"
        current="wallet"
        links={['pay', 'mobile-order']}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
