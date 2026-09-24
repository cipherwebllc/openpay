// 決済 QR の SVG / PNG 保存 (QrGenerator から移設・処理は不変)。qrRef の所有と
// 呼び出し (モーダルの保存ボタン) は QrGenerator に残し、ここは渡された ref の
// <svg> を直列化してダウンロードさせるだけ。
import { triggerDownload } from '@/lib/download';

const FILENAME_FALLBACK = 'openpay';

// 主要 OS (macOS APFS / Windows NTFS / Linux ext4) は UTF-8 ファイル名を許容する
// ため日本語店舗名 (例「神田珈琲」) もそのまま残す。除去対象は path separator・
// Windows 予約文字・制御文字・空白・ダッシュ連続のみ。これを ASCII 限定の
// 正規化にすると日本語名が常に fallback に潰れて merchant が混乱する。
export function fileSafe(value: string): string {
  const normalized = value
    .replace(/[-\\/:*?"<>|\s\x00-\x1f\x7f]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || FILENAME_FALLBACK;
}

function svgMarkup(ref: React.RefObject<HTMLDivElement | null>): string | null {
  const svg = ref.current?.querySelector('svg');
  return svg ? new XMLSerializer().serializeToString(svg) : null;
}

export function downloadSvg(filename: string, ref: React.RefObject<HTMLDivElement | null>) {
  const markup = svgMarkup(ref);
  if (!markup) return;
  const url = URL.createObjectURL(
    new Blob([markup], { type: 'image/svg+xml;charset=utf-8' }),
  );
  triggerDownload(url, filename);
  URL.revokeObjectURL(url);
}

export function downloadPng(filename: string, ref: React.RefObject<HTMLDivElement | null>) {
  const markup = svgMarkup(ref);
  if (!markup) return;
  const img = new Image();
  img.onload = () => {
    // QR は常に正方形 (qrcode.react 出力)、img.width = img.height
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.width;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, img.width, img.width);
    ctx.drawImage(img, 0, 0);
    triggerDownload(canvas.toDataURL('image/png'), filename);
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}
