'use client';

// qr-scanner (Nimiq) のライフサイクルを React に統合するフック。
//
// 設計:
//   - start() は user gesture (button click) からのみ呼ぶ。getUserMedia は
//     gesture 由来でないと iOS Safari / Chrome で permission prompt すら出ない。
//   - qr-scanner module 自体は動的 import で /scan ページのみに code-split。
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

// qr-scanner v1.4.x の ScanResult shape (types 参照)。動的 import の利点を
// 残すため type-only 依存にせず最小定義を再宣言。
export type DecodeResult = { data: string };

export type UseQrScannerOptions = {
  // 1 つの decode 後に自動で stop するか。OpenPay /scan UX は「読んだら即遷移」
  // なので true 既定。連続読取が必要なときに false。
  stopOnDecode?: boolean;
  // hasCamera() を起動前に呼んで no-camera を device 列挙で先に判定する。
  // default true。
  preflightCheckCamera?: boolean;
};

export type UseQrScannerResult = {
  state: ScannerState;
  // 起動 (user gesture から呼ぶこと)。失敗時も reject せず state で表現するため
  // 呼出側に try/catch を強制しない。
  start(): Promise<void>;
  // 明示停止。unmount cleanup でも実行されるため UI から呼ぶ必要は通常ない。
  stop(): void;
};

type QrScannerInstance = InstanceType<typeof import('qr-scanner')['default']>;

function classifyMediaError(err: unknown): ScannerState {
  // getUserMedia は DOMException で標準名 (NotAllowedError, NotFoundError 等)
  // を返す。WebKit の variation も Spec 準拠の name で classify。
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
  // QrScanner instance は ref 保持 — render に巻き込まず再生成ループを防ぐ。
  const scannerRef = useRef<QrScannerInstance | null>(null);
  // onDecode は呼出側で毎 render 変化し得るため ref 経由で最新を読む。
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  }, [onDecode]);

  function disposeScanner(): void {
    const sc = scannerRef.current;
    if (!sc) return;
    sc.stop();
    sc.destroy();
    scannerRef.current = null;
  }

  const stop = useCallback(() => {
    disposeScanner();
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

    const { default: QrScanner } = await import('qr-scanner');

    if (preflightCheckCamera && !(await QrScanner.hasCamera())) {
      setState({ status: 'no-camera' });
      return;
    }

    const scanner = new QrScanner(
      video,
      (result) => {
        // stopOnDecode のときは callback 呼出「前」に dispose して、同一値の
        // 重複 decode (cornerPoints だけ違う) を構造的に防ぐ。
        if (stopOnDecode) {
          disposeScanner();
          setState({ status: 'idle' });
        }
        onDecodeRef.current(result);
      },
      {
        preferredCamera: 'environment',
        // "No QR code found" は frame ごとに発火する仕様。実エラーは scanner
        // 内部で video イベントに繋がるためここで捕まえる必要はない。
        onDecodeError: () => {},
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
      },
    );

    scannerRef.current = scanner;
    // start() の reject は getUserMedia 失敗のみ。defensive ではなく実装要件で
    // .catch() で classify (await の reject は unhandled rejection 化するため)。
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
  useEffect(() => disposeScanner, []);

  return { state, start, stop };
}
