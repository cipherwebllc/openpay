'use client';

// qr-scanner (Nimiq) のライフサイクルを React に統合するフック。
//
// 設計:
//   - start() は user gesture (button click) からのみ呼ぶ。getUserMedia は
//     gesture 由来でないと iOS Safari / Chrome で permission prompt すら出ない。
//   - qr-scanner module 自体は動的 import で /scan ページのみに code-split。
//     他 route の bundle に乗らないため home / pay / tip のサイズ不変。
//   - decode 結果 (data: string) は呼出側に渡し、本フックは中身を解釈しない
//     (URL 判定は lib/scan/parseScannedUrl.ts が SoT)。
//   - 「No QR code found」は qr-scanner が onDecodeError に毎フレーム流すが、
//     エラーではないので無視。実エラー (camera 切断, NotAllowed) のみ state へ。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'scanning'
  | 'permission-denied'
  | 'no-camera'
  | 'error';

export type ScannerState =
  | { status: Exclude<ScannerStatus, 'error'> }
  | { status: 'error'; error: Error };

// qr-scanner v1.4.x の ScanResult shape (types 参照)。
// 実 module の型を `import('qr-scanner')` から取れるが、本ファイルを
// type-only 依存にするため最小定義を再宣言する (dynamic import の利点を活かす)。
export type DecodeResult = { data: string };

export type UseQrScannerOptions = {
  // 1 つの decode 後に自動で stop するか。OpenPay /scan UX は「読んだら即遷移」
  // なので true 既定。連続読取が必要なケースのために false も許容する。
  stopOnDecode?: boolean;
  // 後述 navigator.permissions が無い環境 (iOS Safari < 16 等) で no-camera を
  // 区別したい時のために hasCamera() を起動前に呼ぶオプション。default true。
  preflightCheckCamera?: boolean;
};

export type UseQrScannerResult = {
  state: ScannerState;
  // 起動 (user gesture から呼ぶこと)。Promise<void> は permission 拒否時も
  // reject せず resolve する (state で表現)。呼出側に try/catch を強制しない。
  start(): Promise<void>;
  // 明示停止。unmount cleanup でも実行されるため、UI から手動で呼ぶ必要は
  // 通常ない。SuccessOverlay 表示中の camera 露出を消す等の用途で呼ぶ。
  stop(): void;
};

// qr-scanner module を 1 度だけ読み込む。dynamic import は Promise を返すが、
// hook 呼出ごとに import すると Network 通信ではなく ESM cache から即返るため
// 重ねがけしても問題ない。型は default export 1 つ。
type QrScannerModule = typeof import('qr-scanner');

function classifyMediaError(err: unknown): ScannerState {
  // getUserMedia は DOMException で標準名 (NotAllowedError, NotFoundError 等)
  // を返す。WebKit は legacy NotAllowedError == "Permission denied" 等の variation
  // を持つため name の正規化を Spec 準拠で実施。
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
      return { status: 'permission-denied' };
    }
    if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      return { status: 'no-camera' };
    }
    return { status: 'error', error: new Error(err.message || err.name) };
  }
  if (err instanceof Error) return { status: 'error', error: err };
  return { status: 'error', error: new Error(String(err)) };
}

export function useQrScanner(
  videoRef: RefObject<HTMLVideoElement | null>,
  onDecode: (result: DecodeResult) => void,
  options: UseQrScannerOptions = {},
): UseQrScannerResult {
  const { stopOnDecode = true, preflightCheckCamera = true } = options;
  const [state, setState] = useState<ScannerState>({ status: 'idle' });
  // QrScanner instance を ref で保持 — render に巻き込まないことで
  // state 変更 → re-render → 再生成のループを構造的に防ぐ。
  const scannerRef = useRef<InstanceType<QrScannerModule['default']> | null>(
    null,
  );
  // start() / stop() が clojure 内で常に最新 callback を読めるよう ref 化。
  // 呼出側が onDecode の参照を毎 render 変えても、scanner を再生成しない。
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  const stop = useCallback(() => {
    const sc = scannerRef.current;
    if (sc) {
      sc.stop();
      sc.destroy();
      scannerRef.current = null;
    }
    setState({ status: 'idle' });
  }, []);

  const start = useCallback(async () => {
    if (scannerRef.current) return;
    const video = videoRef.current;
    if (!video) {
      setState({
        status: 'error',
        error: new Error('video element is not mounted'),
      });
      return;
    }
    setState({ status: 'starting' });

    const mod = await import('qr-scanner');
    const QrScanner = mod.default;

    if (preflightCheckCamera) {
      const ok = await QrScanner.hasCamera();
      if (!ok) {
        setState({ status: 'no-camera' });
        return;
      }
    }

    const scanner = new QrScanner(
      video,
      (result) => {
        // stopOnDecode のときは callback を呼ぶ「前」に stop する。
        // 同一フレームで重複 decode (cornerPoints 異なる同一値) を防ぐため。
        if (stopOnDecode) {
          scanner.stop();
          scanner.destroy();
          scannerRef.current = null;
          setState({ status: 'idle' });
        }
        onDecodeRef.current(result);
      },
      {
        // 背面カメラ (スマホでのデフォルト)。前面しか無い PC は qr-scanner が
        // automatically fallback する。
        preferredCamera: 'environment',
        // qr-scanner は frame ごとに onDecodeError を発火するため、"No QR code
        // found" を毎回 console に出さないよう無視 callback を渡す。実エラー
        // (track ended 等) は qr-scanner 内部で video イベントに繋がるので
        // ここで捕まえる必要はない。
        onDecodeError: () => {},
        // 矩形ハイライト + コードアウトラインは UI overlay と相性が良いため有効化。
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
      },
    );

    scannerRef.current = scanner;
    // start() の reject は getUserMedia 失敗 (= permission / device 問題) のみ。
    // try/catch なしの await は再 throw して unhandled rejection になるため、
    // ここだけは Promise.catch で classify する。defensive ではなく実装要件。
    await scanner.start().then(
      () => setState({ status: 'scanning' }),
      (err) => {
        scanner.destroy();
        scannerRef.current = null;
        setState(classifyMediaError(err));
      },
    );
  }, [preflightCheckCamera, stopOnDecode, videoRef]);

  // unmount で必ず停止 (camera の LED を残さない、メモリリーク回避)。
  useEffect(() => {
    return () => {
      const sc = scannerRef.current;
      if (sc) {
        sc.stop();
        sc.destroy();
        scannerRef.current = null;
      }
    };
  }, []);

  return { state, start, stop };
}
