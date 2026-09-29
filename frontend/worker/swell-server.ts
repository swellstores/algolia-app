import { AlgoliaError, SyncError, parseCreatedAfter, syncProductsPage, type SwellClient } from '../../functions/lib/algolia';

export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

// Swell supplies these headers per request. Never embed store values at build time.
export function publicContext(request: Request) {
  const headers = request.headers;
  const storeId = headers.get('Swell-Store-Id');
  const publicKey = headers.get('Swell-Public-Key');
  const storefrontApiOrigin = headers.get('Swell-Admin-Url');
  if (!storeId || !publicKey || !storefrontApiOrigin) {
    return json({ error: 'Open this frontend through swell app dev or its Swell app address.' }, 503);
  }
  return json({
    storeId, publicKey, storefrontApiOrigin,
    environmentId: headers.get('Swell-Environment-Id'),
    appId: headers.get('Swell-App-Id'),
    storefrontId: headers.get('Swell-Storefront-Id'),
  });
}

type BackendContext = { storeId: string; apiHost: string; accessToken: string; appId: string };

// Validates the staff session against Swell and requires it to belong to the current store.
async function authorizeStaff(request: Request): Promise<BackendContext | Response> {
  const cookie = (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim()).find((part) => part.startsWith('_swell_admin_session='));
  let sessionId;
  try { sessionId = cookie && decodeURIComponent(cookie.slice('_swell_admin_session='.length)); }
  catch { return json({ error: 'Invalid session' }, 401); }
  if (!sessionId) return json({ error: 'Open this app from the Swell dashboard to sign in.' }, 401);

  const storeId = request.headers.get('Swell-Store-Id');
  const adminUrl = request.headers.get('Swell-Admin-Url');
  const apiHost = request.headers.get('Swell-API-Host');
  const accessToken = request.headers.get('Swell-Access-Token');
  const appId = request.headers.get('Swell-App-Id') || 'algolia';
  if (!storeId || !adminUrl || !apiHost || !accessToken) {
    return json({ error: 'Swell request context is unavailable' }, 503);
  }
  try {
    const sessionResponse = await fetch(new URL('/admin/api/session', adminUrl), {
      headers: { 'X-Session': sessionId }, redirect: 'manual',
    });
    const session = sessionResponse.ok ? await sessionResponse.json() as { user_id?: string; client_id?: string } : null;
    if (!session?.user_id || session.client_id !== storeId) {
      return json({ error: 'Unauthorized' }, 401);
    }
  } catch (err) {
    const details = { step: 'validate admin session', exception: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    console.error('Algolia sync: session check threw', details);
    return json({ error: 'Unable to complete the platform request', details }, 502);
  }
  return { storeId, apiHost, accessToken, appId };
}

// CSRF protection for cookie-authenticated mutations: same-origin JSON requests only.
function isSameOriginJson(request: Request) {
  const origin = request.headers.get('Origin');
  const contentType = request.headers.get('Content-Type') || '';
  return Boolean(origin) && origin === new URL(request.url).origin
    && contentType.startsWith('application/json');
}

// Upstream Backend API failure, with details that are safe to show to staff
class BackendError extends Error {
  details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown>) {
    super(message);
    this.details = details;
  }
}

function stringifyQuery(query: Record<string, unknown>, prefix = ''): string {
  return Object.entries(query).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (value === undefined) return [];
    if (value !== null && typeof value === 'object') {
      const nested = stringifyQuery(value as Record<string, unknown>, name);
      return nested ? [nested] : [];
    }
    return [`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`];
  }).join('&');
}

// Backend API client with the app's credentials, the same ones Swell gives app functions.
function backendClient({ storeId, apiHost, accessToken, appId }: BackendContext): SwellClient & { redact(text: string): string } {
  const auth = btoa(`${storeId}:${accessToken}`);
  const redact = (text: string) => text.split(accessToken).join('[redacted]').split(auth).join('[redacted]');

  async function request(method: 'GET', path: string, query?: Record<string, unknown>) {
    const search = query ? stringifyQuery(query) : '';
    const response = await fetch(new URL(`${path}${search ? `?${search}` : ''}`, apiHost), {
      method,
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      redirect: 'manual',
    });
    const text = await response.text();
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { /* not JSON */ }
    const message = upstreamMessage(data as { error?: unknown; message?: unknown } | null);
    if (!response.ok || (data !== null && typeof data === 'object' && 'error' in data)) {
      throw new BackendError(message || `Swell API ${method} ${path} failed with HTTP ${response.status}`, {
        step: 'swell api',
        method,
        path,
        status: response.status,
        statusText: response.statusText,
        response: redact(text.slice(0, 2000)),
      });
    }
    return data;
  }

  return {
    get: (url, query) => request('GET', url, query),
    settings: (id = appId) => request('GET', `/settings/${encodeURIComponent(id)}`),
    redact,
  };
}

// Fixed operation: push one page of products to Algolia.
// Any validated staff session for this store may run a sync.
export async function adminSyncPage(request: Request) {
  if (!isSameOriginJson(request)) return json({ error: 'Forbidden' }, 403);

  let page: unknown;
  let createdAfter: string | undefined;
  try {
    const body = await request.json() as { page?: unknown; created_after?: unknown };
    page = body.page;
    createdAfter = parseCreatedAfter(body.created_after);
  } catch (err) {
    return json({ error: err instanceof SyncError ? err.message : 'Invalid request body' }, 400);
  }
  if (!Number.isInteger(page) || (page as number) < 1) return json({ error: 'Invalid page' }, 400);

  const context = await authorizeStaff(request);
  if (context instanceof Response) return context;
  const swell = backendClient(context);

  try {
    const result = await syncProductsPage(swell, page as number, { createdAfter });
    return json({
      page: result.page, limit: result.limit, count: result.count,
      synced: result.synced, done: result.done,
    });
  } catch (err) {
    let status = 502;
    let details: Record<string, unknown>;
    if (err instanceof SyncError) {
      status = err.status;
      details = { step: 'sync', page };
    } else if (err instanceof BackendError) {
      details = { ...err.details, page };
    } else if (err instanceof AlgoliaError) {
      details = { step: 'algolia', page, status: err.status };
    } else {
      details = { step: 'sync', page, exception: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    if (createdAfter) details.created_after = createdAfter;
    const message = swell.redact(err instanceof Error ? err.message : String(err)) || 'Unable to sync products';
    details = JSON.parse(swell.redact(JSON.stringify(details)));
    console.error('Algolia sync failed', { message, details });
    return json({ error: message, details }, status);
  }
}

// Swell errors come as { error: string }, { error: { message } } or { message }.
function upstreamMessage(result: { error?: unknown; message?: unknown } | null): string | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const { error, message } = result;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return typeof message === 'string' ? message : undefined;
}
