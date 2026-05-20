'use client';

// qr-scanner (Nimiq) のライフサイクルを React に統合するフック。
//
// 設計:
//   - start() は user gesture (button click) からのみ呼ぶ。getUserMedia は
//     gesture 由来でないと iOS Safari / Chrome で permission prompt すら出ない。
//   - qr-scanner module 自体は動的 import で /scan ページのみに code-split。
//   - URL 判定は lib/scan/parseScannedUrl.ts が SoT — 本フックは raw data のみ渡す。
//   - 「No QR code found」は qr-scanner が onDecodeError に毎フレーム流す正常状態。
//     実エラー (track ended / worker crash) のみ logger.warn で観測点を残す。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { logger } from '@/lib/logger';

type QrScannerModule = typeof import('qr-scanner');
type QrScannerInstance = InstanceType<QrScannerModule['default']>;

type ScannerState =
  | { status: 'idle' | 'starting' | 'scanning' | 'permission-denied' | 'no-camera' }
  | { status: 'error'; error: Error };

// qr-scanner v1.4.x ScanResult の最小型 (動的 import の利点を残すため再宣言)。
export type DecodeResult = { data: string };

type UseQrScannerOptions = {
  // 1 decode 後に自動 stop。OpenPay /scan UX は「読んだら即遷移」なので true 既定。
  stopOnDecode?: boolean;
  // hasCamera() を起動前に呼んで no-camera を device 列挙で先に判定する。default true。
  preflightCheckCamera?: boolean;
};

type UseQrScannerResult = {
  state: ScannerState;
  // user gesture から呼ぶ。失敗時も reject せず state で表現 (呼出側 try/catch 不要)。
  start(): Promise<void>;
  stop(): void;
};

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
    // videoRef は QrScannerSurface が JSX で attach し、button click で start を
    // 呼ぶ時点で必ず attach されているため非 null 断言で OK。null guard は
    // 不可能状況に対する defensive code になる。
    const video = videoRef.current!;
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
        // worker crash) は logger.warn で観測点を確保する。UI には出さない。
        //
        // 注: qr-scanner v1.4.x は "No QR code found" を裸でも
        // "Scanner error: No QR code found" の prefix 付きでも投げる
        // (内部実装の error wrap 経路次第)。両方の format を filter する必要あり
        // — e2e で実 module を走らせて初めて発覚した quirk。
        onDecodeError: (err) => {
          const detail = err instanceof Error ? err.message : String(err);
          if (
            detail === 'No QR code found' ||
            detail.endsWith(': No QR code found')
          ) {
            return;
          }
          logger.warn('scan.decode_error', { detail });
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
