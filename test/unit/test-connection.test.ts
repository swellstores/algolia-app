import { afterEach, describe, expect, it, vi } from "vitest";
import testConnection, { config } from "../../functions/test-connection";
import { createMockRequest } from "../helpers/mock-request";
import { algoliaSettings, mockFetch } from "../helpers/algolia-fetch";

afterEach(() => {
  vi.restoreAllMocks();
});

function run(settings: any = algoliaSettings) {
  return testConnection(createMockRequest({ swell: { settings: vi.fn().mockResolvedValue(settings) } }));
}

const keysOk = Response.json({ keys: [] });

describe("test-connection function", () => {
  it("is an action", () => {
    expect(config.action).toBe(true);
  });

  it("asks for the keys without calling Algolia", async () => {
    const { calls } = mockFetch();
    await expect(run({ algolia: { api_application_id: "APPID" } })).rejects.toMatchObject({
      status: 400,
      message: "Add the Application ID and Admin API Key and save the settings first.",
    });
    expect(calls).toHaveLength(0);
  });

  it("names the application and counts the index records with read-only calls", async () => {
    const { calls } = mockFetch({
      "GET algolia/1/keys": keysOk,
      "GET algolia/1/indexes/products": Response.json({ nbHits: 1234, hits: [] }),
    });
    await expect(run()).resolves.toEqual({
      message: "Connected to Algolia application APPID, index products (1,234 records).",
    });
    expect(calls.map((c) => c.method)).toEqual(["GET", "GET"]);
    expect(calls[1].url.search).toBe("?hitsPerPage=0");
  });

  it("says a missing index is created by the first sync", async () => {
    mockFetch({
      "GET algolia/1/keys": keysOk,
      "GET algolia/1/indexes/products": Response.json({ message: "Index does not exist", status: 404 }, { status: 404 }),
    });
    await expect(run()).resolves.toEqual({
      message: "Connected to Algolia application APPID. The index products doesn't exist yet; Products → Algolia sync creates it.",
    });
  });

  it("rejects keys Algolia doesn't accept", async () => {
    mockFetch({
      "GET algolia/1/keys": Response.json({ message: "Invalid Application-ID or API key", status: 403 }, { status: 403 }),
    });
    await expect(run()).rejects.toThrow(/didn't accept the Application ID and Admin API Key/);
  });

  it("rejects a key that isn't the Admin API Key", async () => {
    mockFetch({
      "GET algolia/1/keys": Response.json({ message: "Method not allowed with this API key", status: 403 }, { status: 403 }),
    });
    await expect(run()).rejects.toThrow(/not the Admin API Key/);
  });

  it("says when Algolia can't be reached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(run()).rejects.toThrow(/couldn't be reached for the Application ID APPID/);
  });
});
