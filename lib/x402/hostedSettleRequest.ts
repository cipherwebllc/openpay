// hosted paid route (app/api/paid/hosted/[id]) が同じプロセスの中で facilitator /settle の route handler を直接呼ぶ
// ときの印。WeakSet に入れた Request object そのものだけが印を持つので、外の HTTP からは作れない (header や body の
// 値では判定しない = 外から settle を直接叩く経路の制限は弱まらない)。
//
// 何のための印か: hosted の settle は買い手の IP の転送ヘッダを付けて呼ぶ (cloneForwardHeaders)。印が無いと、
// 買い手が自分の IP の relay-admission の枠 (/api/relay/jpyc 等と共有・120 回/分) を先に使い切るだけで settle を
// ip_rate_limited (broadcast 前の拒否 = failed_prebroadcast) にでき、限定在庫 (ライセンス) の押さえを支払わずに残せた。
// 印のある呼び出しは同じ IP でも別の枠 (hosted-settle) で数える。
const hostedSettleRequests = new WeakSet<Request>();

export function markHostedSettleRequest(req: Request): Request {
  hostedSettleRequests.add(req);
  return req;
}

export function isHostedSettleRequest(req: Request): boolean {
  return hostedSettleRequests.has(req);
}
