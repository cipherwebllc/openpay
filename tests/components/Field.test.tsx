import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from '@/components/Field';

describe('Field', () => {
  it('label を uppercase tracking-wide のラベルとして表示し、children を内側にレンダリング', () => {
    render(
      <Field label="ウォレット">
        <input type="text" data-testid="child" />
      </Field>,
    );
    const label = screen.getByText('ウォレット');
    expect(label.tagName).toBe('SPAN');
    expect(label.className).toMatch(/uppercase/);
    expect(label.className).toMatch(/tracking-wide/);
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('複数の children を保持', () => {
    render(
      <Field label="x">
        <span>A</span>
        <span>B</span>
      </Field>,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('B')).toBeInTheDocument();
  });

  it('label は HTML エスケープされる (XSS 防止 — React 本来の挙動だが回帰検出)', () => {
    render(<Field label={'<script>alert(1)</script>'}>{null}</Field>);
    expect(
      screen.getByText('<script>alert(1)</script>'),
    ).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
