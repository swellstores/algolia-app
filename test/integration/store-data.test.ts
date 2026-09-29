import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  getAlgoliaSettings,
  getCategoryLookup,
  getLanguages,
  productQuery,
} from "../../functions/lib/algolia";
import { createSwellClient } from "../helpers/swell-client";

// Read-only checks against the test environment of the store you are logged in to with
// the Swell CLI. Nothing here writes to Swell or Algolia.
describe("store data used by the sync (read-only)", () => {
  const swell = createSwellClient();

  it("reads the app settings", async () => {
    const { settings } = await getAlgoliaSettings(swell);

    expect(typeof settings).toBe("object");
  });

  it("reads store locales", async () => {
    const languages = await getLanguages(swell);

    expect(languages === null || Array.isArray(languages)).toBe(true);
  });

  it("builds the category lookup", async () => {
    const lookup = await getCategoryLookup(swell);

    for (const category of Object.values(lookup)) {
      expect(category.accumulated.length).toBeGreaterThan(0);
    }
  });

  it("pages active products oldest first with the sync query", async () => {
    const languages = await getLanguages(swell);
    const result = await swell.get("/products", {
      ...productQuery(languages),
      sort: "date_created asc",
      limit: DEFAULT_PAGE_SIZE,
      page: 1,
      fields: "date_created,active",
    });

    const dates = result.results.map((product: any) => product.date_created);
    expect(result.results.length).toBeLessThanOrEqual(DEFAULT_PAGE_SIZE);
    expect(result.results.every((product: any) => product.active !== false)).toBe(true);
    expect([...dates].sort()).toEqual(dates);
  });

  it("filters products by creation date", async () => {
    const since = "2100-01-01T00:00:00.000Z";
    const result = await swell.get("/products", {
      ...productQuery(null),
      date_created: { $gte: since },
      limit: 1,
    });

    expect(result.count).toBe(0);
  });
});
