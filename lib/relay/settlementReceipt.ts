import 'server-only';

// 照合の本体は client と共有の純関数 (お店の端末も送った tx の確認に使う)。server 側の入口はここのまま。
export { hasMatchingForwarderSettlement } from '@/lib/relay/forwarderSettledEvent';
