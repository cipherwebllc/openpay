// 決済 QR が「実際に読み取れる」ことを機械的に固定するフェンス。
//
// QrPreviewModal は QR 中央に OpenPay マークを重ねる。誤り訂正 level・表示サイズ・マーク比率の
// どれを崩しても **店頭でスキャンできない = 決済不能** になるが、目視レビューでは検出できない。
// そこで実際に描画 → ラスタ化 → デコードして元 URL と一致することを検証する。
//
// ⚠️ **鮮明な画像だけで検証してはいけない**: 初版は 2x/4x の鮮明ラスタだけを見ていたため
// level='H' を通してしまい、実機カメラで読めない QR を出荷しかけた (2026-07-26)。level を上げると
// モジュール数が増えて 1 マスが細り、距離・角度・ぼけのある実機で先に破綻する。以降は
// **縮小 + ぼかしを掛けた劣化条件を必ず含める**。

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import sharp from 'sharp';
import jsQR from 'jsqr';
import { QR_CENTER_MARK, QR_CENTER_MARK_RATIO } from '@/lib/qrCenterMark';

// QrPreviewModal と同じ描画条件 (ここを変えたら本体も変わっているはず)。
const QR_SIZE = 340;
const QR_LEVEL = 'Q' as const;
const MARK = Math.round(QR_SIZE * QR_CENTER_MARK_RATIO);

// 実運用の最長クラスの決済 URL (受取先 + token + gas + amount)。
const PAY_URL =
  'https://open-pay.jp/pay?to=0x428483fba62edcef1e3a100d3799f6d71759c560&token=jpyc&gas=merchant&amount=12345';

function markup(level: 'L' | 'M' | 'Q' | 'H' = QR_LEVEL, markSize = MARK, value = PAY_URL): string {
  return renderToStaticMarkup(
    <QRCodeSVG
      value={value}
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

/** px 四方へラスタ化し、必要ならぼかしてからデコードする (カメラ相当の劣化を模す)。 */
async function decode(
  svg: string,
  px: number,
  blurSigma?: number,
): Promise<string | null> {
  let img = sharp(Buffer.from(svg))
    .resize(px, px, { fit: 'fill' })
    .flatten({ background: '#ffffff' });
  if (blurSigma) img = img.blur(blurSigma);
  const raw = await img.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const res = jsQR(
    new Uint8ClampedArray(raw.data),
    raw.info.width,
    raw.info.height,
  );
  return res ? res.data : null;
}

describe('決済 QR の読み取り可能性 (中央マーク付き)', () => {
  it('鮮明な描画 (等倍 / 印刷相当の高解像度) でデコードできる', async () => {
    expect(await decode(markup(), QR_SIZE)).toBe(PAY_URL);
    expect(await decode(markup(), QR_SIZE * 3)).toBe(PAY_URL);
  });

  // 実機カメラは「小さく写る + ピントが甘い」。ここが初版に欠けていた検証。
  it('縮小 + ぼかし (実機カメラ相当の劣化) でもデコードできる', async () => {
    expect(await decode(markup(), QR_SIZE, 1.5)).toBe(PAY_URL);
    expect(await decode(markup(), 240, 1.2)).toBe(PAY_URL);
    expect(await decode(markup(), 170, 1.0)).toBe(PAY_URL);
  });

  it('誤り訂正 level を H に上げると劣化条件で破綻する (= 上げてはいけない根拠)', async () => {
    // H は訂正能力こそ高いがモジュールが細る。マークの被覆は面積の約 3% しかなく、
    // Q の 25% で十分余裕があるため、H にする理由がない。
    expect(await decode(markup('H'), 170, 1.0)).toBeNull();
  });

  it('中央マークは QR 幅の 17% を超えない (超えると訂正能力を食い潰す)', () => {
    expect(QR_CENTER_MARK_RATIO).toBeLessThanOrEqual(0.17);
    expect(MARK).toBeLessThanOrEqual(Math.round(QR_SIZE * 0.17));
  });

  it('マークは data URI である (外部参照は PNG 保存でロゴが欠落する)', () => {
    expect(QR_CENTER_MARK.startsWith('data:image/')).toBe(true);
  });
});

// 会計ごとの印 (bill key・`&bk=` + 11 字) は、画面に表示中の JPYC・回収の QR にだけ載る (hooks/useQrBillKey.ts)。
// URL が 15 字長くなり、QR のマスが増える (1 マスが細る)。どこまで読めるかを、bill key なしの QR と同じ条件で固定する。
// bill key を 11 字 (64 bit) にしているのは、このためでもある: 22 字 (128 bit) では、同じ URL が 57 マスになり、
// いちばん厳しい条件 (170px + ぼかし) で読めなかった (下の最後の test)。
describe('会計ごとの印 (bill key) つきの決済 QR の読み取り', () => {
  const BILL_KEY_URL = `${PAY_URL}&bk=Zm9vYmFyYmE`;
  // 余白 (includeMargin = 4 マスずつ) を除いた、QR の 1 辺のマスの数。
  const modules = (svg: string) => Number(/viewBox="0 0 (\d+) \d+"/.exec(svg)![1]) - 8;
  const withKey = (url = BILL_KEY_URL) => markup(QR_LEVEL, MARK, url);

  it('1 辺のマスは 49 → 53 (version 8 → 9・画面の QR だけ。印刷・保存の QR は 49 のまま)', () => {
    expect(PAY_URL).toHaveLength(106);
    expect(BILL_KEY_URL).toHaveLength(121);
    expect(modules(markup())).toBe(49);
    expect(modules(withKey())).toBe(53);
  });

  it('鮮明な描画でも、縮小 + ぼかし (bill key なしの QR と同じ 3 条件) でもデコードできる', async () => {
    expect(await decode(withKey(), QR_SIZE)).toBe(BILL_KEY_URL);
    expect(await decode(withKey(), QR_SIZE * 3)).toBe(BILL_KEY_URL);
    expect(await decode(withKey(), QR_SIZE, 1.5)).toBe(BILL_KEY_URL);
    expect(await decode(withKey(), 240, 1.2)).toBe(BILL_KEY_URL);
    expect(await decode(withKey(), 170, 1.0)).toBe(BILL_KEY_URL);
  });

  it('53 マスに収まるのは 130 字まで: bill key つきで 131 字以上になる URL は 57 マスになる', () => {
    const pad = (length: number) => `${PAY_URL}${'0'.repeat(length - 15 - PAY_URL.length)}&bk=Zm9vYmFyYmE`;
    expect(pad(130)).toHaveLength(130);
    expect(modules(withKey(pad(130)))).toBe(53);
    expect(modules(withKey(pad(131)))).toBe(57);
  });

  // bill key を 22 字 (128 bit) にしない根拠: 同じ URL が 57 マス (上の「level を H に上げた QR」と同じ数) になり、
  // いちばん厳しい条件で読めない。
  it('22 字の bill key では 57 マスになり、170px + ぼかしで読めない (= 11 字にしている根拠)', async () => {
    const long = `${PAY_URL}&bk=Zm9vYmFyYmF6cXV4MTIzNA`;
    expect(modules(withKey(long))).toBe(57);
    expect(modules(markup('H'))).toBe(57);
    expect(await decode(withKey(long), 170, 1.0)).toBeNull();
  });
});
