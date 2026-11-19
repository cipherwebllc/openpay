// @vitest-environment node
// @handle の持ち主の GET /api/handle の imageUpload (プロフの画像の欄を出すか)。出品者の GET (app/api/store/seller) と同じ
// 判定 (lib/images/config の imageUploadAvailableFor): 段階 admin なら運営者だけ・all なら全員・ownerKey の秘密・Blob の store・
// IP の枠の秘密 (IP_HASH_SECRET) のどれかが無ければ false (POST /api/images/upload が 503 になるのに欄を出さない)。
// env を読むだけで、KV (一覧の読み取りのほか)・Blob に触れない。既存の応答の形 (handles・max・Cache-Control) は変えない。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = '0x52d4901142e2B5680027da5EB47C86CB02a3cA81';
const OTHER = '0x2222222222222222222222222222222222222222';
const IMAGE_SECRET = 'test-image-owner-secret-0123456789abcdef';
const IP_SECRET = 'test-ip-hash-secret-0123456789abcdef';

const state = vi.hoisted(() => ({ enableHandles: true, address: '' }));
const store = vi.hoisted(() => ({ listHandleRecordsForOwner: vi.fn() }));
const blob = vi.hoisted(() => ({ list: vi.fn(), put: vi.fn() }));

vi.mock('@/lib/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get enableHandles() {
        return state.enableHandles;
      },
    },
  };
});
vi.mock('@/lib/siweSession', () => ({
  requireSession: async () =>
    state.address
      ? { ok: true, address: state.address }
      : {
        ok: false,
        response: new Response(JSON.stringify({ ok: false, error: 'unauthenticated' }), { status: 401 }),
      },
}));
vi.mock('@/lib/handleStore', () => store);
vi.mock('@vercel/blob', () => blob);

import { GET } from '@/app/api/handle/route';
import { hashIpBucket } from '@/lib/net/ipHash';

const RECORD = {
  handle: 'alice',
  record: {
    owner: OWNER,
    config: { to: OWNER, methods: [{ token: 'jpyc', chain: 'polygon' }] },
    profile: { bio: 'hi', avatar: 'https://images.example/a.png' },
    createdAt: 1,
    updatedAt: 2,
  },
};

async function imageUploadFlag(): Promise<unknown> {
  const response = await GET();
  expect(response.status).toBe(200);
  return ((await response.json()) as { imageUpload?: unknown }).imageUpload;
}

beforeEach(() => {
  state.enableHandles = true;
  state.address = OWNER;
  store.listHandleRecordsForOwner.mockReset();
  store.listHandleRecordsForOwner.mockResolvedValue([RECORD]);
  blob.list.mockReset();
  blob.put.mockReset();
  vi.stubEnv('IMAGE_UPLOAD_MODE', 'admin');
  vi.stubEnv('IMAGE_OWNER_KEY_SECRET', IMAGE_SECRET);
  vi.stubEnv('BLOB_STORE_ID', 'store_test');
  vi.stubEnv('IP_HASH_SECRET', IP_SECRET);
  vi.stubEnv('ADMIN_WALLETS', `0x3333333333333333333333333333333333333333, ${OWNER}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/handle の imageUpload', () => {
  it('段階 admin・運営者・秘密と Blob と IP の秘密がそろえば true', async () => {
    expect(await imageUploadFlag()).toBe(true);
  });

  it('段階 all なら運営者でなくても true', async () => {
    vi.stubEnv('IMAGE_UPLOAD_MODE', 'all');
    state.address = OTHER;
    expect(await imageUploadFlag()).toBe(true);
  });

  it.each([
    ['段階が未設定 (off)', () => vi.stubEnv('IMAGE_UPLOAD_MODE', undefined)],
    ['段階 off', () => vi.stubEnv('IMAGE_UPLOAD_MODE', 'off')],
    ['段階が不正な値 (off と同じ)', () => vi.stubEnv('IMAGE_UPLOAD_MODE', 'yes')],
    ['段階 admin で運営者でない', () => {
      state.address = OTHER;
    }],
    ['ADMIN_WALLETS が空', () => vi.stubEnv('ADMIN_WALLETS', '')],
    ['ownerKey の秘密が無い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', undefined)],
    ['ownerKey の秘密が短い', () => vi.stubEnv('IMAGE_OWNER_KEY_SECRET', 'short')],
    ['Blob の store が無い', () => vi.stubEnv('BLOB_STORE_ID', undefined)],
    ['Blob の store が空白だけ', () => vi.stubEnv('BLOB_STORE_ID', '  ')],
    ['IP の枠の秘密 (IP_HASH_SECRET) が無い', () => vi.stubEnv('IP_HASH_SECRET', undefined)],
    ['IP の枠の秘密が 32 byte より短い', () => vi.stubEnv('IP_HASH_SECRET', 'a'.repeat(31))],
  ])('%s なら false (画面は今の URL の欄のまま)', async (_label, setup) => {
    setup();
    expect(await imageUploadFlag()).toBe(false);
  });

  it('IP の秘密の長さの判定は、POST が使う hashIpBucket と同じ (31 byte = どちらも無効・32 byte = どちらも有効)', async () => {
    vi.stubEnv('IP_HASH_SECRET', 'a'.repeat(31));
    expect(hashIpBucket('192.0.2.1')).toBeNull();
    expect(await imageUploadFlag()).toBe(false);
    vi.stubEnv('IP_HASH_SECRET', 'a'.repeat(32));
    expect(hashIpBucket('192.0.2.1')).not.toBeNull();
    expect(await imageUploadFlag()).toBe(true);
  });

  it('既存の応答の形は変えない (handles・max・Cache-Control に imageUpload を足すだけ)', async () => {
    const response = await GET();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      ok: true,
      handles: [{ handle: 'alice', config: RECORD.record.config, profile: RECORD.record.profile, updatedAt: 2 }],
      max: 3,
      imageUpload: true,
    });
  });

  it('サインインしていなければ 401 で、imageUpload を返さない', async () => {
    state.address = '';
    const response = await GET();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'unauthenticated' });
    expect(store.listHandleRecordsForOwner).not.toHaveBeenCalled();
  });

  it('handles の flag が OFF なら 404 (今のまま)', async () => {
    state.enableHandles = false;
    expect((await GET()).status).toBe(404);
  });

  it('一覧の KV が失敗したら今までどおり 502 (imageUpload を付けない)', async () => {
    store.listHandleRecordsForOwner.mockResolvedValue(null);
    const response = await GET();
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: 'kv_error' });
  });

  it('GET は Blob に触れない', async () => {
    await imageUploadFlag();
    expect(blob.list).not.toHaveBeenCalled();
    expect(blob.put).not.toHaveBeenCalled();
  });
});
