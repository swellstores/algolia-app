import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES, SyncError, syncProductsPage } from "../../functions/lib/algolia";
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

    expect(result).toEqual({ page: 1, limit: DEFAULT_PAGE_SIZE, count: 2, synced: 2, done: true });
    expect(swell.get).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ active: true, limit: DEFAULT_PAGE_SIZE, page: 1, sort: "date_created asc" }),
    );
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /1/keys",
      "POST /1/indexes/products/batch",
    ]);
    expect(calls[1].body.requests.map((request: any) => request.body.objectID)).toEqual(["p1", "p2"]);
  });

  it("is not done while a page is full, and checks keys only on the first page", async () => {
    const swell = mockSwell({ results: products(DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE), count: DEFAULT_PAGE_SIZE * 3 });
    const { calls } = mockFetch(algoliaRoutes);

    const result = await syncProductsPage(swell, 2);

    expect(result).toEqual({ page: 2, limit: DEFAULT_PAGE_SIZE, count: DEFAULT_PAGE_SIZE * 3, synced: DEFAULT_PAGE_SIZE, done: false });
    expect(calls.some((call) => call.url.pathname === "/1/keys")).toBe(false);
  });

  it.each(PAGE_SIZES)("uses a page size of %i", async (limit) => {
    const swell = mockSwell({ results: products(limit), count: limit * 2 });
    mockFetch(algoliaRoutes);

    const result = await syncProductsPage(swell, 2, { limit });

    expect(result).toEqual({ page: 2, limit, count: limit * 2, synced: limit, done: false });
    expect(swell.get).toHaveBeenCalledWith("/products", expect.objectContaining({ limit, page: 2 }));
  });

  it("is done when a page has fewer products than the page size", async () => {
    const swell = mockSwell({ results: products(9), count: 19 });
    mockFetch(algoliaRoutes);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await syncProductsPage(swell, 2, { limit: 10 });

    expect(result).toMatchObject({ limit: 10, synced: 9, done: true });
  });

  it.each([0, 50, 1001, 5000])("rejects page size %i", async (limit) => {
    const error = await syncProductsPage(mockSwell(), 1, { limit }).catch((err) => err);

    expect(error).toBeInstanceOf(SyncError);
    expect(error).toMatchObject({ status: 400, message: "Invalid page size, use one of 10, 100, 200, 500, 1000" });
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
