// /agent「Agent を接続」の純ロジック (setup prompt・MCP 設定の生成・入力検証)。
//
// ここが生成するのは **Agent 実行環境へ貼り付ける文字列だけ**。OpenPay の Web/サーバーは
// Agent 側の env や spend.json を読めも書けもしない (上限を強制するのは Agent 側の MCP/SDK)。
// env 名・既定値の SoT は packages/x402-sdk/src/guards.mjs — 食い違いは
// tests/lib/agentSetup.test.ts のドリフトフェンスが CI で検出する。
//
// 秘密情報は生成物に一切含めない。署名方式は `SIGNER_MODE=keystore` (openpay-x402-mcp 0.15 以降):
// 鍵は MCP が利用者のマシン上で生成・保管し (`wallet_init`)、AI には公開アドレスしか返さない。
// 人が鍵を用意して env に貼る手順は無い (`BUYER_PRIVATE_KEY=0x...` のプレースホルダは MCP が起動時に拒否する)。
// ウォレット未作成でも discovery_search / x402_quote は動き、x402_pay だけが wallet_not_initialized で止まる。

export const AGENT_SETUP_URL = 'https://open-pay.jp/agent/setup.md';

export const AGENT_MCP_PACKAGE = 'openpay-x402-mcp';
/**
 * 生成するコマンドは minor を固定する。無固定の `npx` だと、将来の publish が既に配った設定の挙動を
 * 遡って変えてしまい、Web を戻しても取り消せない。packages/x402-mcp/package.json の minor と一致
 * (tests/lib/agentSetup.test.ts のフェンス)。keystore は 0.15 から・購入ログ (wallet_history) は 0.16 から。
 */
export const AGENT_MCP_VERSION = '0.16';
export const AGENT_MCP_SPEC = `${AGENT_MCP_PACKAGE}@${AGENT_MCP_VERSION}`;
export const AGENT_PAYS_SERVER = 'openpay-x402';
export const HUMAN_PAYS_SERVER = 'openpay-order';

/** guards.mjs の DEFAULT_* と同値 (ドリフトフェンス対象)。 */
export const AGENT_LIMIT_DEFAULTS = {
  maxPerCallJpyc: '10',
  maxSessionJpyc: '100',
  allowedHosts: 'open-pay.jp',
  catalogTrust: true,
} as const;

export const AGENT_CLIENTS = [
  'claude-code',
  'codex',
  'hermes',
  'claude-desktop',
] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

export const AGENT_MODES = ['agent-pays', 'human-pays'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export type AgentConfigInput = {
  maxPerCallJpyc: string;
  maxSessionJpyc: string;
  /** 空文字 = 未設定 (日次上限なし)。 */
  maxDailyJpyc: string;
  /** カンマ区切りの bare host。 */
  allowedHosts: string;
  catalogTrust: boolean;
};

export type AgentConfigField =
  | 'maxPerCallJpyc'
  | 'maxSessionJpyc'
  | 'maxDailyJpyc'
  | 'allowedHosts';

export const DEFAULT_AGENT_CONFIG_INPUT: AgentConfigInput = {
  maxPerCallJpyc: AGENT_LIMIT_DEFAULTS.maxPerCallJpyc,
  maxSessionJpyc: AGENT_LIMIT_DEFAULTS.maxSessionJpyc,
  maxDailyJpyc: '',
  allowedHosts: AGENT_LIMIT_DEFAULTS.allowedHosts,
  catalogTrust: AGENT_LIMIT_DEFAULTS.catalogTrust,
};

// guards.mjs parseJpycToAtomic と同じ受理形 (小数 18 桁まで・0 より大きい)。
const JPYC_DECIMAL = /^[0-9]+(?:\.[0-9]{1,18})?$/;

function isPositiveJpyc(raw: string): boolean {
  return JPYC_DECIMAL.test(raw) && /[1-9]/.test(raw);
}

/** guards.mjs parseAllowedHosts と同じ規則で正規化する。不正な entry があれば null。 */
export function normalizeAllowedHosts(raw: string): string[] | null {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  const hosts: string[] = [];
  for (const part of parts) {
    if (part.includes('://')) return null;
    let parsed: URL;
    try {
      parsed = new URL(`http://${part}`);
    } catch {
      return null;
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    if (parsed.username || parsed.password || parsed.port) return null;
    hosts.push(parsed.hostname.toLowerCase());
  }
  return [...new Set(hosts)];
}

/** 不正なフィールドの一覧 (空 = 生成してよい)。 */
export function invalidAgentConfigFields(
  input: AgentConfigInput,
): AgentConfigField[] {
  const invalid: AgentConfigField[] = [];
  if (!isPositiveJpyc(input.maxPerCallJpyc)) invalid.push('maxPerCallJpyc');
  if (!isPositiveJpyc(input.maxSessionJpyc)) invalid.push('maxSessionJpyc');
  if (input.maxDailyJpyc !== '' && !isPositiveJpyc(input.maxDailyJpyc)) {
    invalid.push('maxDailyJpyc');
  }
  if (normalizeAllowedHosts(input.allowedHosts) === null) {
    invalid.push('allowedHosts');
  }
  return invalid;
}

/** 生成設定に入れる env (秘密は含めない)。入力は検証済みであること。 */
export function buildAgentEnv(input: AgentConfigInput): [string, string][] {
  const hosts = normalizeAllowedHosts(input.allowedHosts);
  if (hosts === null || invalidAgentConfigFields(input).length > 0) {
    throw new Error('agent config input is invalid');
  }
  const entries: [string, string][] = [
    ['SIGNER_MODE', 'keystore'],
    ['MAX_PER_CALL_JPYC', input.maxPerCallJpyc],
    ['MAX_SESSION_JPYC', input.maxSessionJpyc],
  ];
  if (input.maxDailyJpyc !== '') {
    entries.push(['MAX_DAILY_JPYC', input.maxDailyJpyc]);
  }
  entries.push(['ALLOWED_HOSTS', hosts.join(',')]);
  entries.push(['CATALOG_TRUST', input.catalogTrust ? 'true' : 'false']);
  return entries;
}

// URL の hostname として受理されるシェル記号が、生成コマンドの実行へ波及しないよう引用する。
function shellArgument(value: string): string {
  if (/^[a-zA-Z0-9_.,=:/-]+$/.test(value)) return value;
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function launchFor(mode: AgentMode): { server: string; args: string[] } {
  return mode === 'human-pays'
    ? {
        server: HUMAN_PAYS_SERVER,
        args: ['--yes', `--package=${AGENT_MCP_SPEC}`, '--', 'openpay-order-mcp'],
      }
    : { server: AGENT_PAYS_SERVER, args: ['--yes', AGENT_MCP_SPEC] };
}

/**
 * 利用環境ごとの MCP 設定を文字列で返す。human-pays は鍵も上限も不要なので env を出さない
 * (上限は Agent が触らないウォレットには適用されない)。
 */
export function renderAgentConfig(
  client: AgentClient,
  mode: AgentMode,
  input: AgentConfigInput,
): string {
  const { server, args } = launchFor(mode);
  const env = mode === 'agent-pays' ? buildAgentEnv(input) : [];

  if (client === 'claude-desktop') {
    const entry: Record<string, unknown> = { command: 'npx', args };
    if (env.length > 0) entry.env = Object.fromEntries(env);
    return JSON.stringify({ mcpServers: { [server]: entry } }, null, 2);
  }
  if (client === 'codex') {
    const lines = [
      `[mcp_servers.${server}]`,
      'command = "npx"',
      `args = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    ];
    if (env.length > 0) {
      lines.push('', `[mcp_servers.${server}.env]`);
      for (const [key, value] of env) lines.push(`${key} = ${JSON.stringify(value)}`);
    }
    return lines.join('\n');
  }
  if (client === 'hermes') {
    // hermes mcp add は --args が最後のオプション (以降を全て引数として取る)。
    const envPart = env.length > 0 ? ` --env ${env.map(([k, v]) => shellArgument(`${k}=${v}`)).join(' ')}` : '';
    return `hermes mcp add ${server} --command npx${envPart} --args ${args.join(' ')}`;
  }
  const envPart = env.map(([k, v]) => ` -e ${shellArgument(`${k}=${v}`)}`).join('');
  return `claude mcp add ${server}${envPart} -- npx ${args.join(' ')}`;
}

export const AGENT_OPEN_IN_APPS = ['claude', 'codex'] as const;
export type AgentOpenInApp = (typeof AGENT_OPEN_IN_APPS)[number];

/**
 * prompt を入力済みにしてデスクトップアプリの新規セッションを開く deep link。どちらもシェルを持つ
 * ローカルの Agent (Claude Code / Codex) が開くので、Web チャットと違い setup を実行できる。
 * 受け口は各アプリの URL handler で確認済み (2026-09-21): Claude = `claude://code/new?q=`
 * (14,336 字まで・`/` 始まりは拒否) / Codex = `codex://threads/new?prompt=`。
 * アプリ未導入だとリンクは何も起こさないため、UI はコピーを第一導線のまま残す。
 */
export function buildOpenInLink(app: AgentOpenInApp, prompt: string): string {
  const encoded = encodeURIComponent(prompt);
  return app === 'claude'
    ? `claude://code/new?q=${encoded}`
    : `codex://threads/new?prompt=${encoded}`;
}

/** Agent に渡す setup prompt。手順の本体は setup.md 側に置き、ここは方針だけを固定する。 */
export function buildSetupPrompt(locale: string): string {
  if (locale === 'en') {
    return [
      'Set me up to pay in JPYC through OpenPay.',
      '',
      `Run \`curl -sL ${AGENT_SETUP_URL}\` and follow the returned instructions.`,
      '',
      'Rules:',
      '- Never ask me for a private key, and never read, print, log, or send one anywhere (not to this chat, not to OpenPay, not to any third party). The MCP server creates the wallet key on this machine and shows you only its public address.',
      '- Assume a dedicated low-balance agent wallet, not my main wallet.',
      '- Set the per-call, per-session, and daily spending limits and the allowed hosts. Ask me for the amounts if I have not given them.',
      '- Do not make any real payment during setup.',
      '',
      'When you are done, report: the config you wrote, the limits you applied, the agent wallet address and the link where I can fund it and check its JPYC balance, and which JPYC resources on the OpenPay AI Store this agent can buy right now (with a quote for one of them).',
    ].join('\n');
  }
  return [
    'OpenPay を使って JPYC で支払いできるように設定してください。',
    '',
    `\`curl -sL ${AGENT_SETUP_URL}\` を実行し、返ってきた手順に従ってください。`,
    '',
    'ルール:',
    '- 秘密鍵を私に尋ねないでください。秘密鍵を読み出したり、このチャット・OpenPay・その他の第三者へ表示・記録・送信したりしないでください。ウォレットの鍵は MCP サーバーがこのマシン上で作り、あなたには公開アドレスだけが返ります。',
    '- 支払いには、メインのウォレットではなく少額の専用 Agent Wallet を使う前提で進めてください。',
    '- 1 回・セッション・1 日の支払い上限と、接続先の制限を設定してください。金額を私が指定していなければ尋ねてください。',
    '- 設定中に実際の支払いはしないでください。',
    '',
    '完了したら、書き込んだ設定・適用した支払い上限・Agent Wallet のアドレスと入金/残高確認用のリンク・いまこの Agent が OpenPay AI ストアで購入できる JPYC リソース (うち 1 件の見積もり) を報告してください。',
  ].join('\n');
}
