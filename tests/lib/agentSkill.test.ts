import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { agentPageContentFor } from '@/lib/agentPage';
import { AGENT_SKILL_INSTALL } from '@/lib/agentSetup';

// skills/openpay-agent は public/agent/setup.md を Agent Skills (SKILL.md) の形で配る写し。
// 手順の正本は setup.md (tests/lib/agentSetupMd.test.ts のフェンスもそちらにかかる)。
// 本文が 1 字でもずれると、Skill で入れた AI だけ古い手順で動くので、写しは完全一致で固定する。
const SKILL_DIR = 'skills/openpay-agent';
const skill = readFileSync(`${SKILL_DIR}/SKILL.md`, 'utf8');
const setup = readFileSync('public/agent/setup.md', 'utf8');

function split(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n/.exec(text);
  if (!match) throw new Error('SKILL.md must start with a YAML frontmatter block followed by a blank line');
  return { frontmatter: parse(match[1]), body: text.slice(match[0].length) };
}

describe('OpenPay Agent Skill (skills/openpay-agent)', () => {
  const { frontmatter, body } = split(skill);

  it('copies public/agent/setup.md exactly as its body', () => {
    // 食い違ったら setup.md の全文を SKILL.md の frontmatter の後ろ (空行 1 つの後) へ写す。
    expect(body).toBe(setup);
  });

  it('follows the Agent Skills frontmatter rules', () => {
    expect(Object.keys(frontmatter).sort()).toEqual(['compatibility', 'description', 'license', 'name']);
    expect(frontmatter.name).toBe('openpay-agent');
    expect(String(frontmatter.name)).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(String(frontmatter.name).length).toBeLessThanOrEqual(64);
    expect(String(frontmatter.description).length).toBeLessThanOrEqual(1024);
    expect(String(frontmatter.compatibility).length).toBeLessThanOrEqual(500);
    expect(frontmatter.license).toBe('MIT');
  });

  it('pins the public description and compatibility text', () => {
    expect(frontmatter.description).toBe("Sets up OpenPay's MCP server so an AI agent with a shell can find, quote, and, within limits the person sets, buy JPYC-priced x402 APIs and data on the OpenPay AI Store, or order from a shop and give the person a checkout link to pay from their own wallet. Use when the person wants the agent to pay in JPYC (a Japanese yen stablecoin), buy from the OpenPay AI Store, or order from a shop that accepts JPYC. The agent never handles a private key and makes no payment during setup.");
    expect(frontmatter.compatibility).toBe("Needs a shell, Node.js 22 or newer, network access to open-pay.jp and the npm registry, and write access to the agent's own MCP configuration (Claude Code, Codex CLI, Hermes, or similar).");
  });

  it('quotes one install command on the public pages', () => {
    // npx skills add は owner/repo の skills/ を探す。リポの .claude/skills・.agents/skills は git に入れていない (社内用)。
    expect(AGENT_SKILL_INSTALL).toBe('npx skills add cipherwebllc/openpay');
    expect(readFileSync('public/llms.txt', 'utf8')).toContain(`\`${AGENT_SKILL_INSTALL}\``);
    const readme = readFileSync('packages/x402-mcp/README.md', 'utf8');
    expect(readme).toContain(`${AGENT_SKILL_INSTALL}\n`);
    expect(readme).toContain('gh skill install cipherwebllc/openpay openpay-agent\n');
    expect(readme).toContain('The skill contains instructions only, with no bundled scripts');
    expect(agentPageContentFor('ja').connect.skillNote).toBe('同じ手順を Agent Skill としても配っています:');
    expect(agentPageContentFor('en').connect.skillNote).toBe('The same instructions are also available as an Agent Skill:');
  });

  it('ships SKILL.md only', () => {
    // scripts/ などの実行するコードは同梱しない: 入れる前に人が読めば中身がすべて分かる形にする
    // (AI が実行するのは手順に書いた公式 npm の openpay-x402-mcp だけ)。
    expect(readdirSync(SKILL_DIR)).toEqual(['SKILL.md']);
  });
});
