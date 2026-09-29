import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlgoliaError,
  checkHasKeys,
  deleteObject,
  getAlgoliaSettings,
  saveObject,
  saveObjects,
} from "../../functions/lib/algolia";
import { echoBatch, mockFetch } from "../helpers/algolia-fetch";

const credentials = { appId: "APPID", apiKey: "admin-key", indexName: "my index" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAlgoliaSettings", () => {
  it("normalizes credentials from app settings", async () => {
    const swell = {
      get: vi.fn(),
      settings: vi.fn().mockResolvedValue({
        algolia: { api_application_id: " APPID ", api_admin_key: " key ", index_name: " shop " },
      }),
    };

    const { credentials } = await getAlgoliaSettings(swell);

    expect(credentials).toEqual({ appId: "APPID", apiKey: "key", indexName: "shop" });
  });

  it("defaults the index name to products", async () => {
    const swell = {
      get: vi.fn(),
      settings: vi.fn().mockResolvedValue({
        algolia: { api_application_id: "APPID", api_admin_key: "key", index_name: "  " },
      }),
    };

    const { credentials } = await getAlgoliaSettings(swell);

    expect(credentials?.indexName).toBe("products");
  });

  it.each([{}, { algolia: { api_application_id: "APPID" } }, { algolia: { api_admin_key: "key" } }, null])(
    "returns no credentials when they are incomplete: %j",
    async (settings) => {
      const swell = { get: vi.fn(), settings: vi.fn().mockResolvedValue(settings) };

      const result = await getAlgoliaSettings(swell);

      expect(result.credentials).toBeNull();
    },
  );
});

describe("saveObjects", () => {
  it("sends a batch to the configured index with Algolia auth headers", async () => {
    const { calls } = mockFetch({ "POST algolia/1/indexes/my%20index/batch": echoBatch });

    const objectIDs = await saveObjects(credentials, [{ objectID: "p1", name: "One" }, { name: "No id" }]);

    expect(objectIDs).toEqual(["p1", "generated-1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin).toBe("https://appid.algolia.net");
    expect(calls[0].headers["x-algolia-application-id"]).toBe("APPID");
    expect(calls[0].headers["x-algolia-api-key"]).toBe("admin-key");
    expect(calls[0].body.requests).toEqual([
      { action: "updateObject", body: { objectID: "p1", name: "One" } },
      { action: "addObject", body: { name: "No id" } },
    ]);
  });

  it("does not call Algolia for an empty list", async () => {
    const { calls } = mockFetch();

    expect(await saveObjects(credentials, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("saveObject sends a single object", async () => {
    const { calls } = mockFetch({ "POST algolia/1/indexes/my%20index/batch": echoBatch });

    expect(await saveObject(credentials, { objectID: "p1" })).toEqual(["p1"]);
    expect(calls[0].body.requests).toHaveLength(1);
  });
});

describe("Algolia request retries", () => {
  it("falls back to the next host on 5xx and network errors", async () => {
    let attempt = 0;
    const { calls } = mockFetch({
      "POST algolia/1/indexes/my%20index/batch": (call) => {
        attempt++;
        if (attempt === 1) return new Response("unavailable", { status: 503 });
        if (attempt === 2) throw new TypeError("network down");
        return echoBatch(call);
      },
    });

    expect(await saveObjects(credentials, [{ objectID: "p1" }])).toEqual(["p1"]);
    expect(calls.map((call) => call.url.hostname)).toEqual([
      "appid.algolia.net",
      "appid-1.algolianet.com",
      "appid-2.algolianet.com",
    ]);
  });

  it("throws the last error when every host fails", async () => {
    mockFetch({ "POST algolia/1/indexes/my%20index/batch": new Response("down", { status: 502 }) });

    const error = await saveObjects(credentials, [{ objectID: "p1" }]).catch((err) => err);

    expect(error).toBeInstanceOf(AlgoliaError);
    expect(error.status).toBe(502);
  });

  it("does not retry 4xx errors and reports the Algolia message", async () => {
    const { calls } = mockFetch({
      "POST algolia/1/indexes/my%20index/batch": Response.json({ message: "Record is too big" }, { status: 400 }),
    });

    const error = await saveObjects(credentials, [{ objectID: "p1" }]).catch((err) => err);

    expect(error).toBeInstanceOf(AlgoliaError);
    expect(error.status).toBe(400);
    expect(error.message).toBe("Algolia 400: Record is too big");
    expect(calls).toHaveLength(1);
  });

  it("explains a key without write access", async () => {
    mockFetch({
      "POST algolia/1/indexes/my%20index/batch": Response.json({ message: "Not enough rights to add an object" }, { status: 403 }),
    });

    const error = await saveObjects(credentials, [{ objectID: "p1" }]).catch((err) => err);

    expect(error.message).toMatch(/Not enough rights.*Check that the Admin API Key setting holds a key with write access/);
  });
});

describe("deleteObject", () => {
  it("deletes by encoded object id", async () => {
    const { calls } = mockFetch({
      "DELETE algolia/1/indexes/my%20index/p%2F1": Response.json({ deletedAt: "now" }),
    });

    await deleteObject(credentials, "p/1");

    expect(calls[0].method).toBe("DELETE");
  });
});

describe("checkHasKeys", () => {
  it("is true when the key can list API keys", async () => {
    mockFetch({ "GET algolia/1/keys": Response.json({ keys: [] }) });

    expect(await checkHasKeys(credentials)).toBe(true);
  });

  it("is false when Algolia rejects the key", async () => {
    mockFetch({ "GET algolia/1/keys": Response.json({ message: "Invalid Application-ID or API key" }, { status: 403 }) });
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await checkHasKeys(credentials)).toBe(false);
  });
});
