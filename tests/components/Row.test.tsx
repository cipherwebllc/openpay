import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Row } from '@/components/Row';

describe('Row', () => {
  it('label を <dt>、value を <dd> でレンダリング', () => {
    render(
      <dl>
        <Row label="店主への送金" value="99 USDC" />
      </dl>,
    );
    const dt = screen.getByText('店主への送金');
    const dd = screen.getByText('99 USDC');
    expect(dt.tagName).toBe('DT');
    expect(dd.tagName).toBe('DD');
  });

  it('strong=false (既定) では label は薄い色 / value は通常重み', () => {
    render(
      <dl>
        <Row label="A" value="1" />
      </dl>,
    );
    expect(screen.getByText('A').className).toContain('text-slate-500');
    expect(screen.getByText('1').className).not.toContain('font-semibold');
  });

  it('strong=true では label は濃い色 / value は太字 + 濃色', () => {
    render(
      <dl>
        <Row label="顧客支払額" value="100 USDC" strong />
      </dl>,
    );
    expect(screen.getByText('顧客支払額').className).toContain('text-slate-700');
    const dd = screen.getByText('100 USDC');
    expect(dd.className).toContain('font-semibold');
    expect(dd.className).toContain('text-slate-900');
  });

  it('value は font-mono で表示 (数値の桁揃えのため)', () => {
    render(
      <dl>
        <Row label="x" value="0.1 USDC" />
      </dl>,
    );
    expect(screen.getByText('0.1 USDC').className).toContain('font-mono');
  });
});
