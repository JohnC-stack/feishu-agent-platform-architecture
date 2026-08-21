import { resolveCredentialEnvironment } from './credential-bootstrap.js';

interface FeishuResponse {
  code?: number;
  data?: Record<string, unknown>;
  tenant_access_token?: string;
}

interface ProbeResult {
  endpoint: string;
  httpStatus: number;
  code?: number;
  count?: number;
  resourceIds?: string[];
}

async function main(): Promise<void> {
  await resolveCredentialEnvironment();
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error('Feishu credentials are not configured.');
  }
  const baseUrl = 'https://open.feishu.cn/open-apis/';
  const tokenResponse = await fetch(`${baseUrl}auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenBody = (await tokenResponse.json()) as FeishuResponse;
  const token = tokenBody.tenant_access_token;
  if (!tokenResponse.ok || tokenBody.code !== 0 || !token) {
    console.log(
      JSON.stringify({
        ok: false,
        authentication: { status: tokenResponse.status, code: tokenBody.code },
      }),
    );
    process.exitCode = 1;
    return;
  }

  const probes: ProbeResult[] = [];
  const chats = await probe(
    baseUrl,
    token,
    'im/v1/chats?page_size=50&user_id_type=open_id',
    'chat_id',
  );
  probes.push(chats);
  const chatId = chats.resourceIds?.[0];
  if (chatId) {
    probes.push(
      await probe(
        baseUrl,
        token,
        `im/v1/chats/${encodeURIComponent(chatId)}/members?page_size=50&member_id_type=open_id`,
        'member_id',
      ),
    );
  }
  probes.push(
    await probe(baseUrl, token, 'contact/v3/users?user_id_type=open_id&page_size=50', 'open_id'),
  );
  console.log(
    JSON.stringify({ ok: true, authentication: { status: 200, code: 0 }, probes }, null, 2),
  );
}

async function probe(
  baseUrl: string,
  token: string,
  endpoint: string,
  resourceKey: string,
): Promise<ProbeResult> {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body = (await response.json()) as FeishuResponse;
  const items = Array.isArray(body.data?.items) ? body.data.items : [];
  const resourceIds = items
    .map((item) => readResourceId(item, resourceKey))
    .filter((value): value is string => value !== undefined)
    .slice(0, 50);
  return {
    endpoint: endpoint.split('?')[0] ?? endpoint,
    httpStatus: response.status,
    ...(body.code === undefined ? {} : { code: body.code }),
    count: items.length,
    ...(resourceIds.length > 0 ? { resourceIds } : {}),
  };
}

function readResourceId(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const direct = record[key];
  if (typeof direct === 'string') {
    return direct;
  }
  const memberId = record.member_id;
  return typeof memberId === 'string' ? memberId : undefined;
}

void main();
