import { afterEach, describe, expect, it, vi } from "vitest";
import { config, post } from "../../functions/sync-products";
import { PAGE_LIMIT } from "../../functions/lib/algolia";
import { createMockRequest } from "../helpers/mock-request";
import { algoliaSettings, echoBatch, mockFetch } from "../helpers/algolia-fetch";

afterEach(() => {
  vi.restoreAllMocks();
});

function swellMock(settings: any = algoliaSettings) {
  return {
    settings: vi.fn().mockResolvedValue(settings),
    get: vi.fn(async (url: string) => {
      if (url === "/settings/store") return { locales: [] };
      if (url === "/categories") return { count: 0, results: [] };
      if (url === "/products") return { count: 1, results: [{ id: "p1", name: "One" }] };
      throw new Error(`Unexpected swell.get ${url}`);
    }),
  };
}

describe("sync-products function", () => {
  it("is a private POST route", () => {
    expect(config.route).toEqual({ methods: ["post"], public: false });
  });

  it("syncs the requested page with an optional date filter", async () => {
    const swell = swellMock();
    mockFetch({ "POST algolia/1/indexes/products/batch": echoBatch });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await post(
      createMockRequest({ data: { page: 2, created_after: "2026-09-01T00:00:00.000Z" }, swell }),
    );

    expect(result).toEqual({ page: 2, limit: PAGE_LIMIT, count: 1, synced: 1, done: true });
    expect(swell.get).toHaveBeenCalledWith(
      "/products",
      expect.objectContaining({ page: 2, date_created: { $gte: "2026-09-01T00:00:00.000Z" } }),
    );
  });

  it("defaults to the first page", async () => {
    const swell = swellMock();
    mockFetch({
      "GET algolia/1/keys": Response.json({ keys: [] }),
      "POST algolia/1/indexes/products/batch": echoBatch,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await post(createMockRequest({ data: {}, swell }));

    expect(result.page).toBe(1);
  });

  it("returns 400 for settings problems", async () => {
    const error = await post(createMockRequest({ data: { page: 1 }, swell: swellMock({ algolia: {} }) })).catch((err) => err);

    expect(error.name).toBe("SwellError");
    expect(error.status).toBe(400);
    expect(error.message).toBe("Missing Algolia Application ID or Admin API Key in app settings");
  });

  it("returns 400 for an invalid date", async () => {
    const error = await post(createMockRequest({ data: { page: 1, created_after: "nope" }, swell: swellMock() })).catch((err) => err);

    expect(error.status).toBe(400);
    expect(error.message).toBe("Invalid created_after date");
  });

  it("maps Algolia client errors to 400 and server errors to 502", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    mockFetch({ "POST algolia/1/indexes/products/batch": Response.json({ message: "Record is too big" }, { status: 400 }) });
    const clientError = await post(createMockRequest({ data: { page: 2 }, swell: swellMock() })).catch((err) => err);
    expect(clientError.status).toBe(400);
    expect(clientError.message).toBe("Algolia 400: Record is too big");

    vi.restoreAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch({ "POST algolia/1/indexes/products/batch": new Response("down", { status: 503 }) });
    const serverError = await post(createMockRequest({ data: { page: 2 }, swell: swellMock() })).catch((err) => err);
    expect(serverError.status).toBe(502);
  });
});
