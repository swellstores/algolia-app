import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/product-events";
import { PRODUCT_QUERY } from "../../functions/lib/algolia";
import { createMockRequest } from "../helpers/mock-request";
import { algoliaSettings, echoBatch, mockFetch } from "../helpers/algolia-fetch";

afterEach(() => {
  vi.restoreAllMocks();
});

function swellMock({ settings = algoliaSettings as any, product = { id: "p1", name: "One" } as any } = {}) {
  return {
    settings: vi.fn().mockResolvedValue(settings),
    get: vi.fn(async (url: string) => {
      if (url === "/settings/store") return { locales: [] };
      if (url === "/categories") return { count: 0, results: [] };
      if (url === "/products/p1") return product;
      throw new Error(`Unexpected swell.get ${url}`);
    }),
  };
}

function event(type: string, data: Record<string, unknown> = {}) {
  return { id: "p1", ...data, $event: { type } };
}

describe("product-events function", () => {
  it("listens to product create, update and delete", () => {
    expect(config.model?.events).toEqual(["product.created", "product.updated", "product.deleted"]);
  });

  it.each(["product.created", "product.updated"])("sends the product to Algolia on %s", async (type) => {
    const swell = swellMock();
    const { calls } = mockFetch({ "POST algolia/1/indexes/products/batch": echoBatch });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handler(createMockRequest({ data: event(type, { active: true }), swell }));

    expect(swell.get).toHaveBeenCalledWith("/products/p1", PRODUCT_QUERY);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.requests[0]).toEqual({
      action: "updateObject",
      body: { objectID: "p1", name: "One", categories: [] },
    });
  });

  it("removes the product from Algolia when deleted", async () => {
    const swell = swellMock();
    const { calls } = mockFetch({ "DELETE algolia/1/indexes/products/p1": Response.json({}) });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handler(createMockRequest({ data: event("product.deleted"), swell }));

    expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
    expect(swell.get).not.toHaveBeenCalled();
  });

  it("removes the product from Algolia when deactivated", async () => {
    const { calls } = mockFetch({ "DELETE algolia/1/indexes/products/p1": Response.json({}) });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handler(createMockRequest({ data: event("product.updated", { active: false }), swell: swellMock() }));

    expect(calls.map((call) => call.method)).toEqual(["DELETE"]);
  });

  it("skips products the active query does not return", async () => {
    const { calls } = mockFetch();
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handler(createMockRequest({ data: event("product.created"), swell: swellMock({ product: null }) }));

    expect(calls).toHaveLength(0);
  });

  it("does nothing when syncing product changes is turned off", async () => {
    const swell = swellMock({ settings: { algolia: { ...algoliaSettings.algolia, enabled: false } } });
    const { calls } = mockFetch();

    await handler(createMockRequest({ data: event("product.updated"), swell }));

    expect(calls).toHaveLength(0);
    expect(swell.get).not.toHaveBeenCalled();
  });

  it("does nothing without Algolia credentials", async () => {
    const { calls } = mockFetch();
    vi.spyOn(console, "error").mockImplementation(() => {});

    await handler(createMockRequest({ data: event("product.updated"), swell: swellMock({ settings: { algolia: {} } }) }));

    expect(calls).toHaveLength(0);
  });

  it("does not retry Algolia client errors", async () => {
    mockFetch({ "POST algolia/1/indexes/products/batch": Response.json({ message: "Invalid" }, { status: 403 }) });

    const error = await handler(createMockRequest({ data: event("product.updated"), swell: swellMock() })).catch((err) => err);

    expect(error.name).toBe("SwellError");
    expect(error.status).toBe(403);
  });

  it("rethrows Algolia server errors so the event is retried", async () => {
    mockFetch({ "POST algolia/1/indexes/products/batch": new Response("down", { status: 503 }) });

    const error = await handler(createMockRequest({ data: event("product.updated"), swell: swellMock() })).catch((err) => err);

    expect(error.name).not.toBe("SwellError");
    expect(error.status).toBe(503);
  });
});
