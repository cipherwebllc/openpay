import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { renderWithIntl } from '../_helpers/i18n';
import { OfflineLastQr } from '@/components/OfflineLastQr';
import { LAST_QR_KEY, type LastQrRecord } from '@/lib/offlineQr';

const record: LastQrRecord = {
  payUrl: 'https://open-pay.jp/ja/pay?to=0xabc&amount=1000',
  amountLabel: '1,000 JPYC',
  tokenChainLabel: 'JPYC · Polygon',
  storeName: '神田珈琲',
  ts: 1_700_000_000_000,
};

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

function fireConnectivity(type: 'online' | 'offline') {
  act(() => {
    window.dispatchEvent(new Event(type));
  });
}

describe('OfflineLastQr', () => {
  beforeEach(() => {
    localStorage.clear();
    setOnline(true);
  });
  afterEach(() => {
    setOnline(true);
  });

  it('renders nothing while online', () => {
    localStorage.setItem(LAST_QR_KEY, JSON.stringify(record));
    const { container } = renderWithIntl(<OfflineLastQr />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the last QR card when offline', () => {
    localStorage.setItem(LAST_QR_KEY, JSON.stringify(record));
    setOnline(false);
    renderWithIntl(<OfflineLastQr />);
    expect(screen.getByText('圏外です — 前回の受け取り QR')).toBeInTheDocument();
    expect(screen.getByText('1,000 JPYC')).toBeInTheDocument();
    expect(screen.getByText('JPYC · Polygon')).toBeInTheDocument();
    expect(screen.getByText('神田珈琲')).toBeInTheDocument();
    // QR は端末内生成 (QRCodeSVG)。
    expect(document.querySelector('svg')).not.toBeNull();
    // 支払いはオフライン不可の明示。
    expect(
      screen.getByText(/お支払い .*はオフラインではできません/),
    ).toBeInTheDocument();
  });

  it('renders nothing when offline but no saved QR exists', () => {
    setOnline(false);
    const { container } = renderWithIntl(<OfflineLastQr />);
    expect(container).toBeEmptyDOMElement();
  });

  it('toggles with online/offline events', () => {
    localStorage.setItem(LAST_QR_KEY, JSON.stringify(record));
    renderWithIntl(<OfflineLastQr />);
    // 初期 online → null
    expect(screen.queryByText('圏外です — 前回の受け取り QR')).toBeNull();

    setOnline(false);
    fireConnectivity('offline');
    expect(
      screen.getByText('圏外です — 前回の受け取り QR'),
    ).toBeInTheDocument();

    setOnline(true);
    fireConnectivity('online');
    expect(screen.queryByText('圏外です — 前回の受け取り QR')).toBeNull();
  });
});
