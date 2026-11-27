// AI エージェント向けの読み取りと発見の配線 (2026-11-27・Is Agentic / isitagentready の診断)。
//   ① トップ (/・/ja・/en) を Accept: text/markdown で求めたら Markdown 版 (= public/llms.txt) へ rewrite
//   ② どの API にも当たらない /api/* は JSON (problem+json) の 404
//   ③ /.well-known/api-catalog と /.well-known/agent-skills/index.json が今ある文書だけを指す
//   ④ トップの canonical
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

// next-intl の middleware 実体は vitest で import できない (og-public-url.test.ts と同じ理由)。
// intl に渡ったことは戻り値の null で見分ける。
vi.mock('next-intl/middleware', () => ({
  default: () => () => null,
}));

const { default: middleware } = await import('../../middleware');
const { GET: homeMarkdown } = await import('../../app/api/agent/home-markdown/route');
const notFoundRoute = await import('../../app/api/[[...notFound]]/route');
const { GET: apiCatalogRoute } = await import('../../app/.well-known/api-catalog/route');
const { GET: skillsIndexRoute } = await import(
  '../../app/.well-known/agent-skills/index.json/route'
);
const { GET: skillMdRoute } = await import(
  '../../app/.well-known/agent-skills/openpay-agent/SKILL.md/route'
);
const { AGENT_SKILL_PATH } = await import('../../lib/agentDiscovery');

const MARKDOWN = { accept: 'text/markdown' };
const BROWSER = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function req(path: string, headers: Record<string, string>) {
  return new NextRequest(`https://open-pay.jp${path}`, { headers });
}

describe('① トップの Markdown 版', () => {
  it.each(['/', '/ja', '/en'])('%s を Markdown で求めたら home-markdown へ rewrite (query は捨てる)', (path) => {
    const res = middleware(req(`${path}?utm=x`, MARKDOWN));
    expect(res?.headers.get('x-middleware-rewrite')).toBe(
      'https://open-pay.jp/api/agent/home-markdown',
    );
  });

  it('ブラウザの Accept は今までどおり intl へ', () => {
    expect(middleware(req('/ja', BROWSER))).toBeNull();
    expect(middleware(req('/', BROWSER))).toBeNull();
  });

  it('トップ以外は Markdown を求めても rewrite しない', () => {
    expect(middleware(req('/ja/pricing', MARKDOWN))).toBeNull();
  });

  it('本文は public/llms.txt と同じ bytes・text/markdown・Vary: Accept', async () => {
    const res = homeMarkdown();
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('vary')).toBe('Accept');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(readFileSync(join(process.cwd(), 'public', 'llms.txt')))).toBe(true);
  });
});

describe('② 存在しない /api/* は JSON の 404', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)('%s', async (method) => {
    const res = notFoundRoute[method]();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('application/problem+json; charset=utf-8');
    const body = await res.json();
    expect(body).toMatchObject({ status: 404, title: 'Not Found', error: 'not_found' });
    expect(body.docs).toBe('https://open-pay.jp/openapi.json');
  });
});

describe('③ /.well-known の発見用の文書', () => {
  it('api-catalog は linkset+json で /openapi.json と説明文書を指す', async () => {
    const res = apiCatalogRoute();
    expect(res.headers.get('content-type')).toBe('application/linkset+json');
    const { linkset } = await res.json();
    expect(linkset).toHaveLength(1);
    expect(linkset[0].anchor).toBe('https://open-pay.jp/api/');
    expect(linkset[0]['service-desc'][0].href).toBe('https://open-pay.jp/openapi.json');
    expect(linkset[0]['service-doc'].map((l: { href: string }) => l.href)).toEqual([
      'https://github.com/cipherwebllc/openpay/blob/main/docs/API.md',
      'https://open-pay.jp/llms.txt',
    ]);
  });

  it('agent-skills の目録は配る SKILL.md の sha256 と一致し、url の route が実在する', async () => {
    const index = await skillsIndexRoute().json();
    expect(index.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(index.skills).toHaveLength(1);
    const [skill] = index.skills;
    expect(skill).toMatchObject({ name: 'openpay-agent', type: 'skill-md', url: AGENT_SKILL_PATH });
    expect(skill.description.length).toBeGreaterThan(20);

    const served = Buffer.from(await skillMdRoute().arrayBuffer());
    expect(served.equals(readFileSync(join(process.cwd(), 'skills', 'openpay-agent', 'SKILL.md')))).toBe(true);
    expect(skill.digest).toBe(`sha256:${createHash('sha256').update(served).digest('hex')}`);
    expect(existsSync(join(process.cwd(), 'app', AGENT_SKILL_PATH, 'route.ts'))).toBe(true);
  });
});

describe('④ トップの canonical', () => {
  it.each([
    ['ja', '/ja'],
    ['en', '/en'],
    ['fr', '/ja'],
  ])('locale=%s → canonical %s', async (locale, canonical) => {
    const { generateMetadata } = await import('../../app/[locale]/page');
    const meta = await generateMetadata({ params: Promise.resolve({ locale }) });
    expect(meta.alternates).toEqual({
      canonical,
      languages: { ja: '/ja', en: '/en' },
    });
  });
});
