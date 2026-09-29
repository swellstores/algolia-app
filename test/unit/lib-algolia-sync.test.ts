import { afterEach, describe, expect, it, vi } from "vitest";
import { PAGE_LIMIT, SyncError, syncProductsPage } from "../../functions/lib/algolia";
import { algoliaSettings, echoBatch, mockFetch } from "../helpers/algolia-fetch";

afterEach(() => {
  vi.restoreAllMocks();
});

function products(count: number, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({ id: `p${offset + i + 1}`, name: `Product ${offset + i + 1}` }));
}

function mockSwell({ settings = algoliaSettings as any, results = products(2), count = results.length } = {}) {
  return {
    settings: vi.fn().mockResolvedValue(settings),
    get: vi.fn(async (url: string, _query?: any) => {
      if (url === "/settings/store") return { locales: [] };
      if (url === "/categories") return { count: 0, results: [] };
      if (url === "/products") return { count, results };
      throw new Error(`Unexpected swell.get ${url}`);
    }),
  };
}

const algoliaRoutes = {
  "GET algolia/1/keys": Response.json({ keys: [] }),
  "POST algolia/1/indexes/products/batch": echoBatch,
};

describe("syncProductsPage", () => {
  it("pushes one page of active products and reports progress", async () => {
    const swell = mockSwell();
    const { calls } = mockFetch(algoliaRoutes);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await syncProductsPage(swell, 1);

    expect(result).toEqual({ page: 1, limit: PAGE_LIMIT, count: 2, synced: 2, done: true });
    expect(swell.get).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ active: true, limit: PAGE_LIMIT, page: 1, sort: "date_created asc" }),
    );
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /1/keys",
      "POST /1/indexes/products/batch",
    ]);
    expect(calls[1].body.requests.map((request: any) => request.body.objectID)).toEqual(["p1", "p2"]);
  });

  it("is not done while a page is full, and checks keys only on the first page", async () => {
    const swell = mockSwell({ results: products(PAGE_LIMIT, PAGE_LIMIT), count: PAGE_LIMIT * 3 });
    const { calls } = mockFetch(algoliaRoutes);

    const result = await syncProductsPage(swell, 2);

    expect(result).toEqual({ page: 2, limit: PAGE_LIMIT, count: PAGE_LIMIT * 3, synced: PAGE_LIMIT, done: false });
    expect(calls.some((call) => call.url.pathname === "/1/keys")).toBe(false);
  });

  it("filters by creation date", async () => {
    const swell = mockSwell();
    mockFetch(algoliaRoutes);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await syncProductsPage(swell, 1, { createdAfter: "2026-09-01T00:00:00.000Z" });

    expect(swell.get).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ date_created: { $gte: "2026-09-01T00:00:00.000Z" } }),
    );
  });

  it("does not filter by date without createdAfter", async () => {
    const swell = mockSwell();
    mockFetch(algoliaRoutes);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await syncProductsPage(swell, 1);

    const query = swell.get.mock.calls.find(([url]) => url === "/products")![1];
    expect(query).not.toHaveProperty("date_created");
  });

  it("adds store locales to the product query", async () => {
    const swell = mockSwell();
    swell.get.mockImplementation(async (url: string) => {
      if (url === "/settings/store") return { locales: [{ code: "en" }, { code: "de" }] };
      if (url === "/categories") return { count: 0, results: [] };
      return { count: 0, results: [] };
    });
    mockFetch(algoliaRoutes);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await syncProductsPage(swell, 1);

    expect(swell.get).toHaveBeenCalledWith("/products", expect.objectContaining({ $locale: ["en", "de"] }));
  });

  it.each([0, -1, 1.5, NaN])("rejects page %s", async (page) => {
    const error = await syncProductsPage(mockSwell(), page).catch((err) => err);

    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ status: 400, message: "Invalid page" });
  });

  it("fails when Algolia credentials are not configured", async () => {
    const error = await syncProductsPage(mockSwell({ settings: { algolia: {} } }), 1).catch((err) => err);

    expect(error).toBeInstanceOf(SyncError);
    expect(error.message).toBe("Missing Algolia Application ID or Admin API Key in app settings");
  });

  it("fails on the first page when the Algolia key is invalid", async () => {
    const swell = mockSwell();
    mockFetch({ "GET algolia/1/keys": Response.json({ message: "Invalid" }, { status: 403 }) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const error = await syncProductsPage(swell, 1).catch((err) => err);

    expect(error).toBeInstanceOf(SyncError);
    expect(error.message).toBe("Invalid Application-ID or API key");
    expect(swell.get).not.toHaveBeenCalledWith("/products", expect.anything());
  });
});
