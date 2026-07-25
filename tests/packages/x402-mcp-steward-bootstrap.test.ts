// steward-bootstrap の入力と、signer 発行前のポリシー read-back をネットワーク非依存で検証。

import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCRIPT = resolve(
  process.cwd(),
  'packages/x402-mcp/scripts/steward-bootstrap.mjs',
);

interface SetPolicyArgs {
  fetchImpl?: typeof fetch;
  urlBase: string;
  tenantId: string;
  apiKey: string;
  agentId: string;
  jpycAddress: string;
  forwarderAddress: string;
  chainId: number;
  maxValueAtomic: string;
}

interface BootstrapModule {
  setAndVerifyJpycPolicy(args: SetPolicyArgs): Promise<void>;
}

async function setAndVerifyJpycPolicy(args: SetPolicyArgs) {
  const bootstrap = await import(pathToFileURL(SCRIPT).href) as BootstrapModule;
  return bootstrap.setAndVerifyJpycPolicy(args);
}

function run(env: Record<string, string>) {
  return spawnSync('node', [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 15_000,
  });
}

const POLICY_ARGS = {
  urlBase: 'http://steward.test',
  tenantId: 'openpay',
  apiKey: 'tenant-key',
  agentId: 'jpyc-buyer',
  jpycAddress: '0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29',
  forwarderAddress: '0x0F4560a777415580F0680F8B56a79B0022C6B848',
  chainId: 137,
  maxValueAtomic: '3000000000000000000',
};

interface StoredPolicy {
  id: string;
  agentId: string;
  type: string;
  enabled: boolean;
  config: {
    verifyingContractAllowlist: string[];
    allowedChainIds: number[];
    allowedPrimaryTypes: string[];
    messageConditions: [
      { field: string; operator: string; values: string[] },
      { field: string; operator: string; value: string },
    ];
  };
  createdAt: string;
  updatedAt: string;
}

function storedPolicy(): StoredPolicy {
  return {
    // Steward の置換 API は要求 ID ではなく新しい DB row ID を返す版がある。
    id: '7a0b79b2-a846-469d-ac56-59f675e849a7',
    agentId: POLICY_ARGS.agentId,
    type: 'typed-data',
    enabled: true,
    config: {
      verifyingContractAllowlist: [POLICY_ARGS.jpycAddress],
      allowedChainIds: [POLICY_ARGS.chainId],
      allowedPrimaryTypes: ['ReceiveWithAuthorization'],
      messageConditions: [
        {
          field: 'to',
          operator: 'address_in',
          values: [POLICY_ARGS.forwarderAddress],
        },
        {
          field: 'value',
          operator: 'uint_max',
          value: POLICY_ARGS.maxValueAtomic,
        },
      ],
    },
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('steward-bootstrap input validation', () => {
  it('exits non-zero without STEWARD_PLATFORM_KEY', () => {
    const r = run({ STEWARD_PLATFORM_KEY: '', OWNER_PRIVATE_KEY: '0x' + '11'.repeat(32) });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/STEWARD_PLATFORM_KEY is required/);
  });

  it('exits non-zero with a malformed OWNER_PRIVATE_KEY', () => {
    const r = run({ STEWARD_PLATFORM_KEY: 'k', OWNER_PRIVATE_KEY: 'not-hex' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OWNER_PRIVATE_KEY must be/);
  });
});

describe('steward-bootstrap typed-data policy verification', () => {
  it('accepts only after an exact persisted policy read-back', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [storedPolicy()] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [storedPolicy()] }));

    await expect(setAndVerifyJpycPolicy({ ...POLICY_ARGS, fetchImpl })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'PUT' });
    expect(fetchImpl.mock.calls[1]?.[1]).not.toHaveProperty('method');
    const putBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(putBody).toEqual([
      expect.objectContaining({
        id: 'jpyc-receive',
        type: 'typed-data',
        enabled: true,
      }),
    ]);
  });

  it('rejects a non-JSON PUT response before attempting read-back', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response('<html>proxy fallback</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );

    await expect(setAndVerifyJpycPolicy({ ...POLICY_ARGS, fetchImpl })).rejects.toThrow(
      'policy set returned non-JSON (200)',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a 200 PUT response without an explicit success result', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({ data: null }));

    await expect(setAndVerifyJpycPolicy({ ...POLICY_ARGS, fetchImpl })).rejects.toThrow(
      /policy set failed \(200\)/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('stops bootstrap when Steward does not support typed-data policies', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse({ ok: false, error: 'Unknown policy type "typed-data"' }),
    );

    await expect(setAndVerifyJpycPolicy({ ...POLICY_ARGS, fetchImpl })).rejects.toThrow(
      /update Steward before issuing signer credentials/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  const mismatches: Array<[string, (policy: StoredPolicy) => void]> = [
    ['enabled', (policy) => {
      policy.enabled = false;
    }],
    ['contract', (policy) => {
      policy.config.verifyingContractAllowlist = [
        '0x0000000000000000000000000000000000000001',
      ];
    }],
    ['chain', (policy) => {
      policy.config.allowedChainIds = [1];
    }],
    ['primaryType', (policy) => {
      policy.config.allowedPrimaryTypes = ['Permit'];
    }],
    ['to', (policy) => {
      policy.config.messageConditions[0].values = [
        '0x0000000000000000000000000000000000000002',
      ];
    }],
    ['value', (policy) => {
      policy.config.messageConditions[1].value = '3000000000000000001';
    }],
  ];

  it.each(mismatches)('rejects a read-back mismatch in %s', async (_field, mutate) => {
    const readBack = storedPolicy();
    mutate(readBack);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [storedPolicy()] }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [readBack] }));

    await expect(setAndVerifyJpycPolicy({ ...POLICY_ARGS, fetchImpl })).rejects.toThrow(
      /policy read-back mismatch/,
    );
  });
});
