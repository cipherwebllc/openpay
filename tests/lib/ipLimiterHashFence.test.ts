import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

function callName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)) {
    return expression.argumentExpression.text;
  }
}

function containsFullAddressHash(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && callName(node.expression) === 'hashIp') return true;
  return ts.forEachChild(node, containsFullAddressHash) ?? false;
}

function violations(file: string, source: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) &&
      ['checkIpRateLimit', 'checkRateLimit'].includes(callName(node.expression) ?? '') &&
      node.arguments.some(containsFullAddressHash)) {
      const { line } = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
      found.push(`${file}:${line + 1}: use hashIpBucket for limiter keys`);
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', 'build', 'tests', 'test', 'fixtures'].includes(entry.name)) return [];
      return sourceFiles(path);
    }
    return /\.(?:[cm]?[jt]s|[jt]sx)$/.test(entry.name) ? [path] : [];
  });
}

describe('IP limiter full-address hash fence', () => {
  it.each([
    "checkIpRateLimit('scope', hashIp(clientIp(req)), 30, 60)",
    "await checkIpRateLimit(\n 'scope',\n hashIp(ip),\n 30, 60\n)",
    'checkRateLimit([`prefix:${hashIp(ip)}`])',
    'guards.checkRateLimit([net.hashIp(ip)])',
  ])('rejects full-address limiter keys: %s', (source) => {
    expect(violations('fixture.ts', source)).toHaveLength(1);
  });

  it.each([
    "checkIpRateLimit('scope', hashIpBucket(clientIp(req)), 30, 60)",
    'checkRateLimit([wallet]); hashIp(ip)',
    '// checkRateLimit([hashIp(ip)])\nconst text = "checkRateLimit([hashIp(ip)])";',
  ])('allows bucket/wallet keys and ignores non-code: %s', (source) => {
    expect(violations('fixture.ts', source)).toEqual([]);
  });

  it('never passes hashIp() to checkIpRateLimit/checkRateLimit in production source', () => {
    const files = ['app', 'lib', 'components', 'hooks', 'scripts', 'packages'].flatMap(sourceFiles);
    expect(files).toContain(join('app', 'api', 'admin', 'billing', 'revenue', 'route.ts'));
    const found = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      // Parse only limiter callers; AST traversal handles nested arrays/templates and
      // multiline arguments without treating comments or strings as executable code.
      return /\bcheck(?:Ip)?RateLimit\b/.test(source) ? violations(file, source) : [];
    });
    expect(found).toEqual([]);
  });
});
