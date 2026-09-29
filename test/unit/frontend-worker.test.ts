import { afterEach, describe, expect, it, vi } from "vitest";
import { adminSyncPage, publicContext } from "../../frontend/worker/swell-server";
import { DEFAULT_PAGE_SIZE } from "../../functions/lib/algolia";

// The app frontend Worker endpoint that runs the sync page by page for staff.

const origin = "https://app.example.invalid";
const headers = {
  "Swell-Store-Id": "example",
  "Swell-Public-Key": "public-fixture-key",
  "Swell-Admin-Url": "https://example.swell.store",
  "Swell-API-Host": "https://api.example.invalid",
  "Swell-Access-Token": "private-fixture-token",
  "Swell-App-Id": "algolia",
};

function request(
  cookie: string | null,
  { body = { page: 1 } as unknown, extra = {} as Record<string, string> } = {},
) {
  return new Request(`${origin}/app-api/admin/sync`, {
    method: "POST",
    headers: {
      ...headers,
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validSession = () => Response.json({ user_id: "staff", client_id: "example" });
const noPlatformCalls = () =>
  vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Must not contact the platform");
  });

type Override = Response | ((url: URL, init: RequestInit) => Response | Promise<Response>);

const settings = {
  algolia: { api_application_id: "APPID", api_admin_key: "algolia-admin-key", index_name: "products" },
};

// Routes mocked platform and Algolia calls by URL; `overrides` replaces a route's response.
function mockPlatform(overrides: Record<string, Override> = {}) {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method || "GET";
    calls.push(`${method} ${url.hostname}${url.pathname}`);
    const route = url.hostname.startsWith("appid")
      ? `algolia ${method} ${url.pathname.replace(/\/1\/indexes\/[^/]+/, "/index")}`
      : `${method} ${url.pathname}`;
    const override = overrides[route];
    if (override) return typeof override === "function" ? override(url, init) : override.clone();
    if (!url.hostname.startsWith("appid")) {
      expect(init.redirect).toBe("manual");
    }
    switch (route) {
      case "GET /admin/api/session":
        return validSession();
      case "GET /settings/algolia":
        return Response.json(settings);
      case "GET /settings/store":
        return Response.json({ locales: [] });
      case "GET /categories":
        return Response.json({ count: 0, results: [] });
      case "GET /products":
        return Response.json({ count: 2, results: [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }] });
      case "algolia GET /1/keys":
        return Response.json({ keys: [] });
      case "algolia POST /index/batch": {
        const { requests } = JSON.parse(String(init.body));
        return Response.json({ objectIDs: requests.map((r: any) => r.body.objectID) });
      }
      default:
        throw new Error(`Unexpected request ${route}`);
    }
  });
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("publicContext", () => {
  it("contains public fields only", async () => {
    const result: any = await publicContext(request(null)).json();

    expect(result.storeId).toBe("example");
    expect(result.storefrontApiOrigin).toBe("https://example.swell.store");
    expect(JSON.stringify(result)).not.toContain("private-fixture-token");
    expect(JSON.stringify(result)).not.toContain("api.example.invalid");
  });

  it("explains how to enter through Swell when context is missing", () => {
    expect(publicContext(new Request("http://localhost/")).status).toBe(503);
  });
});

describe("adminSyncPage request checks", () => {
  it.each([{ Origin: "https://evil.example" }, { "Content-Type": "text/plain" }])(
    "rejects cross-site or non-JSON requests: %j",
    async (extra) => {
      noPlatformCalls();
      expect((await adminSyncPage(request("_swell_admin_session=fixture", { extra }))).status).toBe(403);
    },
  );

  it.each(["not json", { page: 0 }, { page: 1.5 }, { page: "2" }])("rejects invalid body: %j", async (body) => {
    noPlatformCalls();
    expect((await adminSyncPage(request("_swell_admin_session=fixture", { body }))).status).toBe(400);
  });

  it.each([null, "_swell_admin_session=%ZZ"])("rejects missing or malformed session: %s", async (cookie) => {
    noPlatformCalls();
    expect((await adminSyncPage(request(cookie))).status).toBe(401);
  });

  it.each([{}, { user_id: "user", client_id: "other-store" }])(
    "rejects invalid or other-store session: %j",
    async (session) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(session));

      expect((await adminSyncPage(request("_swell_admin_session=fixture"))).status).toBe(401);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([50, 1001, "all"])("rejects page size %j before contacting the platform", async (limit) => {
    noPlatformCalls();

    const result = await adminSyncPage(request("_swell_admin_session=fixture", { body: { page: 1, limit } }));

    expect(result.status).toBe(400);
    expect(((await result.json()) as any).error).toBe("Invalid page size, use one of 10, 100, 200, 500, 1000");
  });

  it("rejects an invalid date before contacting the platform", async () => {
    noPlatformCalls();

    const result = await adminSyncPage(
      request("_swell_admin_session=fixture", { body: { page: 1, created_after: "yesterday" } }),
    );

    expect(result.status).toBe(400);
    expect(((await result.json()) as any).error).toBe("Invalid created_after date");
  });

  it.each(["session", "backend"])("rejects %s redirects without following them", async (redirectAt) => {
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init: RequestInit = {}) => {
      calls++;
      expect(init.redirect).toBe("manual");
      if (redirectAt === "backend" && calls === 1) return validSession();
      return new Response(null, { status: 302, headers: { Location: "https://untrusted.example" } });
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture"));

    expect(result.status).toBe(redirectAt === "session" ? 401 : 502);
    expect(calls).toBe(redirectAt === "session" ? 1 : 2);
    if (redirectAt === "backend") expect(((await result.json()) as any).details.status).toBe(302);
  });
});

describe("adminSyncPage sync", () => {
  it("validates the session, syncs one page and returns only progress fields", async () => {
    const calls = mockPlatform({
      "GET /settings/algolia": (_url, init) => {
        expect((init.headers as Record<string, string>).Authorization).toBe(
          `Basic ${btoa("example:private-fixture-token")}`,
        );
        return Response.json(settings);
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture"));

    expect(await result.json()).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE, count: 2, synced: 2, done: true });
    expect(result.headers.get("Cache-Control")).toBe("private, no-store");
    expect(calls[0]).toBe("GET example.swell.store/admin/api/session");
    expect(calls).toContain("GET api.example.invalid/settings/algolia");
    expect(calls).toContain("GET appid.algolia.net/1/keys");
    expect(calls).toContain("POST appid.algolia.net/1/indexes/products/batch");
  });

  it("checks Algolia keys only on the first page and requests the given page", async () => {
    let productsUrl: URL | undefined;
    const calls = mockPlatform({
      "GET /products": (url) => {
        productsUrl = url;
        return Response.json({ count: DEFAULT_PAGE_SIZE + 1, results: [{ id: "p101" }] });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture", { body: { page: 2 } }));

    expect(await result.json()).toEqual({ page: 2, limit: DEFAULT_PAGE_SIZE, count: DEFAULT_PAGE_SIZE + 1, synced: 1, done: true });
    expect(calls).not.toContain("GET appid.algolia.net/1/keys");
    expect(productsUrl?.searchParams.get("page")).toBe("2");
    expect(productsUrl?.searchParams.get("limit")).toBe(String(DEFAULT_PAGE_SIZE));
    expect(productsUrl?.searchParams.get("active")).toBe("true");
  });

  it("syncs only products created on or after the given date", async () => {
    let productsUrl: URL | undefined;
    mockPlatform({
      "GET /products": (url) => {
        productsUrl = url;
        return Response.json({ count: 1, results: [{ id: "p1" }] });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(
      request("_swell_admin_session=fixture", { body: { page: 1, created_after: "2026-09-01T00:00:00+02:00" } }),
    );

    expect(await result.json()).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE, count: 1, synced: 1, done: true });
    expect(productsUrl?.searchParams.get("date_created[$gte]")).toBe("2026-08-31T22:00:00.000Z");
    expect(productsUrl?.searchParams.get("sort")).toBe("date_created asc");
  });

  it("uses the requested page size", async () => {
    let productsUrl: URL | undefined;
    mockPlatform({
      "GET /products": (url) => {
        productsUrl = url;
        return Response.json({ count: 1, results: [{ id: "p1" }] });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture", { body: { page: 1, limit: 1000 } }));

    expect(await result.json()).toEqual({ page: 1, limit: 1000, count: 1, synced: 1, done: true });
    expect(productsUrl?.searchParams.get("limit")).toBe("1000");
  });

  it("syncs all products without a date filter", async () => {
    let productsUrl: URL | undefined;
    mockPlatform({
      "GET /products": (url) => {
        productsUrl = url;
        return Response.json({ count: 0, results: [] });
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await adminSyncPage(request("_swell_admin_session=fixture", { body: { page: 1, created_after: "" } }));

    expect(productsUrl?.searchParams.get("date_created[$gte]")).toBeNull();
  });
});

describe("adminSyncPage errors", () => {
  it("reports missing Algolia credentials", async () => {
    mockPlatform({ "GET /settings/algolia": Response.json({ algolia: {} }) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture"));
    const body: any = await result.json();

    expect(result.status).toBe(400);
    expect(body.error).toBe("Missing Algolia Application ID or Admin API Key in app settings");
    expect(body.details.step).toBe("sync");
  });

  it("reports Algolia errors with their status", async () => {
    mockPlatform({ "algolia POST /index/batch": Response.json({ message: "Record is too big" }, { status: 400 }) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture"));
    const body: any = await result.json();

    expect(result.status).toBe(502);
    expect(body.error).toBe("Algolia 400: Record is too big");
    expect(body.details).toEqual({ step: "algolia", page: 1, status: 400, limit: DEFAULT_PAGE_SIZE });
  });

  it("reports Swell API failures with step, status and body without leaking credentials", async () => {
    mockPlatform({
      "GET /products": new Response("bad gateway private-fixture-token", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture"));
    const body: any = await result.json();

    expect(result.status).toBe(502);
    expect(body.error).toBe("Swell API GET /products failed with HTTP 503");
    expect(body.details).toMatchObject({
      step: "swell api",
      path: "/products",
      status: 503,
      response: "bad gateway [redacted]",
    });
  });

  it("passes Swell API error messages through", async () => {
    mockPlatform({
      "GET /settings/algolia": Response.json({ error: { message: "Permission denied" } }, { status: 403 }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const body: any = await (await adminSyncPage(request("_swell_admin_session=fixture"))).json();

    expect(body.error).toBe("Permission denied");
    expect(body.details.status).toBe(403);
  });

  it("does not leak credentials from upstream exceptions", async () => {
    mockPlatform({
      "GET /settings/algolia": () => {
        throw new Error("private-fixture-token");
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await adminSyncPage(request("_swell_admin_session=fixture"));
    const body = JSON.stringify(await result.json());

    expect(result.status).toBe(502);
    expect(body).not.toContain("private-fixture-token");
    expect(body).toContain("[redacted]");
  });
});
