// 対応するブラウザの push service (2026-09-23 確認)。FCM/Mozilla はホスト名の完全一致、
// Apple/WNS はドット区切りのサブドメインで判定する (任意の接尾辞一致では許可しない)。
// https://github.com/web-push-libs/web-push#usage
// https://mozilla-services.github.io/autopush-rs/
// https://developer.apple.com/videos/play/wwdc2022/10098/
// https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview
export const WEB_PUSH_SERVICE_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  '*.push.apple.com',
  '*.notify.windows.com',
] as const;

export function isAllowedPushEndpoint(endpoint: URL): boolean {
  // 購読入力を介した任意宛先への送信を断つ。許可ホスト上の別ポート/サービスも対象外にする。
  if (endpoint.protocol !== 'https:' || endpoint.port !== '' ||
      endpoint.username !== '' || endpoint.password !== '') return false;
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
  return WEB_PUSH_SERVICE_HOSTS.some((service) => {
    if (!service.startsWith('*.')) return host === service;
    const suffix = service.slice(1);
    return host.length > suffix.length && host.endsWith(suffix);
  });
}
