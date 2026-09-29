import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCT_QUERY,
  SyncError,
  formatProduct,
  getCategoryLookup,
  getLanguages,
  parseCreatedAfter,
  parsePageSize,
  productQuery,
} from "../../functions/lib/algolia";

afterEach(() => {
  vi.restoreAllMocks();
});

const categories = [
  { id: "c1", name: "Clothing", parent_id: null, sort: 0 },
  { id: "c2", name: "Shirts", parent_id: "c1", sort: 0 },
  { id: "c3", name: "Sale", parent_id: null, sort: 1 },
];

function swellWithCategories(pages: any[][]) {
  const count = pages.flat().length;
  return {
    get: vi.fn(async (_url: string, query: any) => ({ count, results: pages[query.page - 1] || [] })),
    settings: vi.fn(),
  };
}

// Category names keep the legacy integration's spacing so existing Algolia facets keep matching.
describe("getCategoryLookup", () => {
  it("builds accumulated category paths", async () => {
    const lookup = await getCategoryLookup(swellWithCategories([categories]));

    expect(lookup).toEqual({
      c1: { newName: " Clothing ", accumulated: [" Clothing "], name: "Clothing" },
      c2: {
        newName: " Clothing  >  Shirts ",
        accumulated: [" Clothing ", " Clothing  >  Shirts "],
        name: "Shirts",
      },
      c3: { newName: " Sale ", accumulated: [" Sale "], name: "Sale" },
    });
  });

  it("reads every page of categories", async () => {
    const swell = swellWithCategories([[categories[0], categories[1]], [categories[2]]]);

    const lookup = await getCategoryLookup(swell);

    expect(Object.keys(lookup).sort()).toEqual(["c1", "c2", "c3"]);
    expect(swell.get).toHaveBeenCalledTimes(2);
    expect(swell.get).toHaveBeenCalledWith("/categories", expect.objectContaining({ limit: 1000, page: 2 }));
  });

  it("breaks circular parent references", async () => {
    const lookup = await getCategoryLookup(
      swellWithCategories([
        [
          { id: "a", name: "A", parent_id: "b", sort: 0 },
          { id: "b", name: "B", parent_id: "a", sort: 0 },
        ],
      ]),
    );

    expect(Object.keys(lookup).sort()).toEqual(["a", "b"]);
  });
});

describe("formatProduct", () => {
  it("maps id, categories, hierarchical levels and bundle items", async () => {
    const lookup = await getCategoryLookup(swellWithCategories([categories]));

    const record = formatProduct(
      {
        id: "p1",
        name: "Tee",
        price: 10,
        sku: "",
        stock_tracking: false,
        category_index: { id: ["c2", "c3"] },
        bundle_items: [{ quantity: 2, product: { name: "Sock" } }],
      },
      lookup,
    );

    expect(record).toEqual({
      objectID: "p1",
      name: "Tee",
      price: 10,
      bundle_items: [{ quantity: 2, name: "Sock" }],
      categories: [" Clothing ", " Clothing  >  Shirts ", " Sale "],
      Shirtslvls: { lvl0: " Clothing ", lvl1: " Clothing  >  Shirts " },
    });
  });

  it("flattens locale values and drops meta fields", () => {
    const record = formatProduct(
      {
        id: "p2",
        name: "Tee",
        meta_title: "Title",
        meta_description: "Meta",
        tags: ["a"],
        $locale: { fr: { name: "T-shirt", description: "Desc" } },
      },
      {},
    );

    expect(record).toEqual({
      objectID: "p2",
      name: "Tee",
      categories: [],
      name_fr: "T-shirt",
      description_fr: "Desc",
    });
  });

  it("ignores categories missing from the lookup", () => {
    const record = formatProduct({ id: "p3", category_index: { id: ["gone"] } }, {});

    expect(record).toEqual({ objectID: "p3", categories: [] });
  });
});

describe("getLanguages", () => {
  it("returns locale codes, preferring fallbacks", async () => {
    const swell = {
      get: vi.fn().mockResolvedValue({ locales: [{ code: "en" }, { code: { fallback: "fr" } }] }),
      settings: vi.fn(),
    };

    expect(await getLanguages(swell)).toEqual(["en", "fr"]);
    expect(swell.get).toHaveBeenCalledWith("/settings/store");
  });

  it("returns null without locales or when store settings fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await getLanguages({ get: vi.fn().mockResolvedValue({ locales: [] }), settings: vi.fn() })).toBeNull();
    expect(await getLanguages({ get: vi.fn().mockRejectedValue(new Error("boom")), settings: vi.fn() })).toBeNull();
  });
});

describe("productQuery", () => {
  it("queries active products with the indexed fields", () => {
    expect(productQuery(null)).toEqual(PRODUCT_QUERY);
    expect(PRODUCT_QUERY.active).toBe(true);
  });

  it("adds locales when the store has them", () => {
    expect(productQuery(["en", "fr"])).toEqual({ ...PRODUCT_QUERY, $locale: ["en", "fr"] });
  });
});

describe("parseCreatedAfter", () => {
  it.each([undefined, null, ""])("treats %j as no filter", (value) => {
    expect(parseCreatedAfter(value)).toBeUndefined();
  });

  it("normalizes dates to ISO", () => {
    expect(parseCreatedAfter("2026-09-01T00:00:00+02:00")).toBe("2026-08-31T22:00:00.000Z");
  });

  it.each(["yesterday", 42, {}])("rejects %j", (value) => {
    expect(() => parseCreatedAfter(value)).toThrow(SyncError);
  });
});

describe("parsePageSize", () => {
  it.each([undefined, null, ""])("defaults %j to 100", (value) => {
    expect(parsePageSize(value)).toBe(100);
  });

  it.each([10, 100, 200, 500, 1000, "500"])("accepts %j", (value) => {
    expect(parsePageSize(value)).toBe(Number(value));
  });

  it.each([0, 1, 99, 1001, "all", 10.5])("rejects %j", (value) => {
    expect(() => parsePageSize(value)).toThrow(SyncError);
  });
});
