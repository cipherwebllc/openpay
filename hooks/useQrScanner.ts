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
import { logger } from '@/lib/logger';

// QrScannerModule の type は dynamic import から推論。
type QrScannerModule = typeof import('qr-scanner');

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

type QrScannerInstance = InstanceType<QrScannerModule['default']>;

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

    // dynamic import (chunk 解決) と hasCamera() の reject は無視すると state が
    // 'starting' に張り付き UI が永久 spinner になる。Promise.catch で classify する。
    let QrScanner: QrScannerModule['default'];
    try {
      ({ default: QrScanner } = await import('qr-scanner'));
    } catch (err) {
      setState(classifyMediaError(err));
      return;
    }

    if (preflightCheckCamera) {
      let hasCam: boolean;
      try {
        hasCam = await QrScanner.hasCamera();
      } catch (err) {
        setState(classifyMediaError(err));
        return;
      }
      if (!hasCam) {
        setState({ status: 'no-camera' });
        return;
      }
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
        // qr-scanner は frame ごとに onDecodeError を発火する。"No QR code found"
        // は QR 不在の正常状態なので捨て、それ以外の本物のエラー (track ended /
        // worker crash) は logger.warn で観測点を確保する。UI には出さない
        // (毎フレーム noise になるため、視覚的劣化を避ける)。
        onDecodeError: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'No QR code found') return;
          logger.warn('scan.decode_error', { msg });
        },
        highlightScanRegion: true,
        highlightCodeOutline: true,
        returnDetailedScanResult: true,
      },
    );

    scannerRef.current = scanner;
    // start() の reject は getUserMedia 失敗のみ。.then(_, err) で classify
    // (await の reject は unhandled rejection 化するため)。
    await scanner.start().then(
      () => setState({ status: 'scanning' }),
      (err) => {
        disposeScanner();
        setState(classifyMediaError(err));
      },
    );
  }, [preflightCheckCamera, stopOnDecode, videoRef]);

  // unmount で必ず停止 (camera の LED を残さない、メモリリーク回避)。
  useEffect(() => disposeScanner, []);

  return { state, start, stop };
}
