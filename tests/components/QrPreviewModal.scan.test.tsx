// 決済 QR が「実際に読み取れる」ことを機械的に固定するフェンス。
//
// QrPreviewModal は QR 中央に OpenPay マークを重ねる。マーク分のモジュールは失われるため、
// 誤り訂正 level を下げたりマークを大きくすると **店頭でスキャンできない = 決済不能** になる。
// 目視レビューでは検出できないので、実際に描画 → ラスタ化 → デコードして元 URL と一致することを
// 検証する。level を 'H' から下げる / QR_CENTER_MARK_RATIO を上げる変更はここで落ちる。

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { QR_CENTER_MARK, QR_CENTER_MARK_RATIO } from '@/lib/qrCenterMark';

// QrPreviewModal と同じ描画条件 (ここを変えたら本体も変わっているはず)。
const QR_SIZE = 260;
const MARK = Math.round(QR_SIZE * QR_CENTER_MARK_RATIO);

// 実運用の最長クラスの決済 URL (受取先 + token + gas + amount)。
const PAY_URL =
  'https://open-pay.jp/pay?to=0x428483fba62edcef1e3a100d3799f6d71759c560&token=jpyc&gas=merchant&amount=12345';

async function decode(markup: string, scale: number): Promise<string | null> {
  const png = await sharp(Buffer.from(markup))
    .resize(QR_SIZE * scale, QR_SIZE * scale, { fit: 'fill' })
    .flatten({ background: '#ffffff' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
  const res = jsQR(
    new Uint8ClampedArray(png.data),
    png.info.width,
    png.info.height,
  );
  return res ? res.data : null;
}

function svg(level: 'L' | 'M' | 'Q' | 'H', markSize: number): string {
  return renderToStaticMarkup(
    <QRCodeSVG
      value={PAY_URL}
      size={QR_SIZE}
      includeMargin
      level={level}
      imageSettings={{
        src: QR_CENTER_MARK,
        height: markSize,
        width: markSize,
        excavate: true,
      }}
    />,
  );
}

describe('決済 QR の読み取り可能性 (中央マーク付き)', () => {
  it('現行設定 (level=H・マーク 17%) は元の決済 URL にデコードできる', async () => {
    const decoded = await decode(svg('H', MARK), 2);
    expect(decoded).toBe(PAY_URL);
  });

  it('印刷相当の高解像度でもデコードできる', async () => {
    const decoded = await decode(svg('H', MARK), 4);
    expect(decoded).toBe(PAY_URL);
  });

  it('中央マークは QR 幅の 17% を超えない (超えると訂正能力を食い潰す)', () => {
    expect(QR_CENTER_MARK_RATIO).toBeLessThanOrEqual(0.17);
    expect(MARK).toBeLessThanOrEqual(Math.round(QR_SIZE * 0.17));
  });

  it('マークは data URI である (外部参照は PNG 保存でロゴが欠落する)', () => {
    expect(QR_CENTER_MARK.startsWith('data:image/')).toBe(true);
  });
});
