// Uses the Algolia REST API over fetch because functions run on Cloudflare Workers.

export const DEFAULT_INDEX = 'products';
// products per sync page: the merchant picks one of these; 1000 is the Swell API maximum
export const PAGE_SIZES = [10, 100, 200, 500, 1000] as const;
export const DEFAULT_PAGE_SIZE = 100;

// product fields
export const PRODUCT_QUERY = {
  fields: [
    'content',
    'currency',
    'meta_description', // text-only option for a product description
    'bundle',
    'bundle_items',
    'images.caption',
    'images.file.height',
    'images.file.url',
    'images.file.width',
    'images.id',
    'name',
    'orig_price',
    'price',
    'sku',
    'slug',
    'stock_status',
    'stock_tracking',
    'stock_purchasable',
    'category_index',
    'description',
    'attributes',
  ].join(','),
  active: true,
  expand: ['bundle_items.product'],
};

// The subset of the Swell client this lib needs. Satisfied by the function's req.swell
// and by the app frontend Worker's Backend API client.
export interface SwellClient {
  get(url: string, query?: any): Promise<any>;
  settings(id?: string): Promise<any>;
}

export interface AlgoliaSettings {
  api_application_id?: string;
  api_admin_key?: string;
  index_name?: string;
  enabled?: boolean;
}

export interface AlgoliaCredentials {
  appId: string;
  apiKey: string;
  indexName: string;
}

type CategoryLookup = Record<
  string,
  { newName: string; accumulated: string[]; name: string }
>;

// read app settings and normalize credentials
export async function getAlgoliaSettings(
  swell: SwellClient,
): Promise<{ settings: AlgoliaSettings; credentials: AlgoliaCredentials | null }> {
  const all = await swell.settings();
  const settings: AlgoliaSettings = all?.algolia || {};

  const appId = settings.api_application_id?.trim();
  const apiKey = settings.api_admin_key?.trim();

  return {
    settings,
    credentials:
      appId && apiKey
        ? { appId, apiKey, indexName: settings.index_name?.trim() || DEFAULT_INDEX }
        : null,
  };
}

// --- Algolia REST client ---

export class AlgoliaError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// there are several URLs, use the first available
function algoliaHosts(appId: string): string[] {
  return [
    `https://${appId}.algolia.net`,
    `https://${appId}-1.algolianet.com`,
    `https://${appId}-2.algolianet.com`,
    `https://${appId}-3.algolianet.com`,
  ];
}

export async function algoliaRequest(
  { appId, apiKey }: AlgoliaCredentials,
  method: string,
  path: string,
  body?: object,
): Promise<any> {
  let lastError: unknown;

  // retry on the fallback hosts for network errors and 5xx, like the official client
  for (const host of algoliaHosts(appId)) {
    try {
      const res = await fetch(`${host}${path}`, {
        method,
        headers: {
          'X-Algolia-Application-Id': appId,
          'X-Algolia-API-Key': apiKey,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.ok) {
        return await res.json();
      }

      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).message || text;
      } catch {
        // not JSON
      }

      // e.g. a Search-Only key saved instead of the Admin API Key
      if (/not enough rights/i.test(message)) {
        message += '. Check that the Admin API Key setting holds a key with write access (addObject, deleteObject) to this index';
      }

      const error = new AlgoliaError(`Algolia ${res.status}: ${message}`, res.status);
      if (res.status < 500) {
        throw error;
      }
      lastError = error;
    } catch (err) {
      if (err instanceof AlgoliaError && err.status < 500) {
        throw err;
      }
      lastError = err;
    }
  }

  throw lastError;
}

// legacy validateLogin(): listing API keys requires the admin key
export async function checkHasKeys(credentials: AlgoliaCredentials): Promise<boolean> {
  try {
    const val = await algoliaRequest(credentials, 'GET', '/1/keys');
    return Boolean(val && 'keys' in val);
  } catch (err) {
    console.error('Algolia: credential check failed', err);
    return false;
  }
}

function indexPath(indexName: string) {
  return `/1/indexes/${encodeURIComponent(indexName)}`;
}

export async function saveObjects(
  credentials: AlgoliaCredentials,
  objects: Record<string, any>[],
): Promise<string[]> {
  if (!objects.length) {
    return [];
  }

  const result = await algoliaRequest(
    credentials,
    'POST',
    `${indexPath(credentials.indexName)}/batch`,
    {
      requests: objects.map((body) => ({
        // autoGenerateObjectIDIfNotExist: add when objectID is missing
        action: body.objectID ? 'updateObject' : 'addObject',
        body,
      })),
    },
  );

  return result?.objectIDs || [];
}

export async function saveObject(
  credentials: AlgoliaCredentials,
  object: Record<string, any>,
): Promise<string[]> {
  return saveObjects(credentials, [object]);
}

export async function deleteObject(
  credentials: AlgoliaCredentials,
  objectID: string,
): Promise<any> {
  return algoliaRequest(
    credentials,
    'DELETE',
    `${indexPath(credentials.indexName)}/${encodeURIComponent(objectID)}`,
  );
}

// --- Swell data ---

// read the locale list from store settings
export async function getLanguages(swell: SwellClient): Promise<string[] | null> {
  let locales: any[] | undefined;

  try {
    const store = await swell.get('/settings/store');
    locales = store?.locales;
  } catch (err) {
    console.warn('Algolia: unable to read store locales', err);
  }

  if (!locales?.length) {
    return null;
  }

  return locales.map((lan) => (lan.code?.fallback ? lan.code.fallback : lan.code));
}

async function getAllCategories(swell: SwellClient): Promise<any[]> {
  const results: any[] = [];
  let page = 1;
  let count = 0;

  do {
    const pageResult = await swell.get('/categories', {
      fields: 'id,name,parent_id,sort',
      sort: 'id desc',
      limit: 1000,
      page,
    });

    if (!pageResult?.results) {
      break;
    }

    results.push(...pageResult.results);
    count = pageResult.count;
    page += 1;
  } while (count > results.length);

  return results;
}

// --- category tree

function isCircular(
  origObj: any,
  key: string | null = null,
  seen = new WeakSet<object>(),
  obj: any = null,
): boolean {
  obj = obj || origObj;

  if (!(obj instanceof Object)) {
    throw new TypeError('isCircular: first parameter must be an object (or inherit from it)');
  }

  seen.add(obj);

  for (const [objKey, val] of Object.entries(obj)) {
    if (!key || key === objKey) {
      if (val instanceof Object) {
        if (seen.has(val) || isCircular(origObj, key, seen, val)) {
          return true;
        }
      }
    }
  }

  seen.delete(obj);

  return false;
}

function buildCategoryIndex(results: any[]): Record<string, any> {
  const index = results.reduce((index, category) => {
    index[category.id] = category;
    return index;
  }, {} as Record<string, any>);

  results.forEach((category) => {
    if (category.parent_id && index[category.parent_id]) {
      index[category.id].parent = index[category.parent_id];

      if (isCircular(index[category.id].parent, 'parent')) {
        index[category.id].parent.parent = undefined;

        if (index[category.id].parent) {
          index[category.id].parent.parent_id = undefined;
        }

        index[category.id].parent = undefined;
        index[category.id].parent_id = undefined;
      } else {
        index[category.parent_id].children = index[category.parent_id].children || [];
        index[category.parent_id].children.push(index[category.id]);
      }
    }
  });

  Object.values(index).forEach((category: any) => {
    // fix bad category relations
    if (category.id === category.parent_id) {
      category.parent_id = undefined;
    }

    if (category.children) {
      category.children.sort((a: any, b: any) => (a.sort > b.sort ? 1 : -1));
      category.children.forEach((child: any, sort: number) => (child.sort = sort));
    }
  });

  return index;
}

function buildCategoryList(index: Record<string, any>): any[] {
  const list = Object.values(index).filter((category: any) => !category.parent_id);

  list.sort((a: any, b: any) => (a.sort > b.sort ? 1 : -1));
  list.forEach((category: any, sort) => (category.sort = sort));

  return list;
}

function formatCategoriesTree(
  category: any,
  { lastName = '', acum = [] as string[] },
): Record<string, { newName: string; accumulated: string[]; name: string }>[] {
  const { name, children, id } = category;
  let childrenMaps: ReturnType<typeof formatCategoriesTree> = [];
  const init = lastName ? `${lastName} > ` : '';
  
  const newName = `${init} ${name} `;
  const accumulated = [...acum, newName];

  if (children) {
    childrenMaps = children
      .map((element: any) =>
        formatCategoriesTree(element, { lastName: newName, acum: accumulated }),
      )
      .flat();
  }

  return [...childrenMaps, { [id]: { newName, accumulated, name } }];
}

// flat { [categoryId]: { accumulated, name } } lookup used to format products
export async function getCategoryLookup(swell: SwellClient): Promise<CategoryLookup> {
  const categories = await getAllCategories(swell);
  const categoriesTree = buildCategoryList(buildCategoryIndex(categories));

  return categoriesTree
    .map((category) => formatCategoriesTree(category, {}))
    .flat()
    .reduce((acum, current) => ({ ...acum, ...current }), {} as CategoryLookup);
}

// --- product formatting ---

function formatProductCategories(product: any, categoryLookup: CategoryLookup) {
  const { id, category_index, ...rest } = product;

  const productCategories = category_index
    ? (category_index.id || []).reduce(
        (acum: any, current: string) => {
          const category = categoryLookup[current] || { accumulated: [] as string[], name: '' };
          acum.categoriesNames.push(category.accumulated);

          if (category.accumulated.length > 1) {
            const levels = category.accumulated.reduce(
              (accumulated: Record<string, string>, current: string, index: number) => {
                accumulated[`lvl${index}`] = current;
                return accumulated;
              },
              {},
            );

            acum.levels[`${category.name}lvls`] = levels;
          }
          return acum;
        },
        { categoriesNames: [] as string[][], levels: {} as Record<string, any> },
      )
    : { categoriesNames: [], levels: {} };

  const categoriesSet = [...new Set(productCategories.categoriesNames.flat())];

  return {
    ...rest,
    objectID: id,
    categories: categoriesSet,
    ...productCategories.levels,
  };
}

// product record shape pushed to Algolia
export function formatProduct(product: any, categoryLookup: CategoryLookup): Record<string, any> {
  let formattedValues: Record<string, any> = formatProductCategories(product, categoryLookup);

  if (formattedValues.bundle_items) {
    formattedValues = {
      ...formattedValues,
      bundle_items: formattedValues.bundle_items.map((element: any) => ({
        quantity: element.quantity,
        name: element.product?.name,
      })),
    };
  }

  if (formattedValues.$locale) {
    const values: Record<string, any> = {};

    Object.keys(formattedValues.$locale).forEach((lang) => {
      Object.keys(formattedValues.$locale[lang] || {}).forEach((subKey) => {
        values[`${subKey}_${lang}`] = formattedValues.$locale[lang][subKey];
      });
    });
    const { name, meta_title, meta_description, tags, $locale, ...rest } = formattedValues;
    formattedValues = { name, ...rest, ...values };
  }

  // omit null values (legacy drops every falsy value)
  const noNullValues: Record<string, any> = {};
  Object.keys(formattedValues).forEach((key) => {
    if (formattedValues[key]) {
      noNullValues[key] = formattedValues[key];
    }
  });

  return noNullValues;
}

export function productQuery(languages: string[] | null): Record<string, any> {
  return languages ? { ...PRODUCT_QUERY, $locale: languages } : { ...PRODUCT_QUERY };
}

// --- full sync ---

// A sync failure the caller should report as-is (status is an HTTP status for the response)
export class SyncError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface SyncPageResult {
  page: number;
  limit: number;
  count: number;
  synced: number;
  done: boolean;
}

export interface SyncOptions {
  // ISO date; only products with date_created >= this date are synced
  createdAfter?: string;
  // products per page, one of PAGE_SIZES
  limit?: number;
}

// Validate an optional page size, defaulting to DEFAULT_PAGE_SIZE
export function parsePageSize(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_PAGE_SIZE;
  }
  const size = Number(value);
  if (!(PAGE_SIZES as readonly number[]).includes(size)) {
    throw new SyncError(`Invalid page size, use one of ${PAGE_SIZES.join(', ')}`, 400);
  }
  return size;
}

// Normalize an optional date filter to ISO, rejecting anything Date can't parse
export function parseCreatedAfter(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const date = typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new SyncError('Invalid created_after date', 400);
  }
  return date.toISOString();
}

// Push one page of active products to Algolia. Called page by page from the app frontend.
export async function syncProductsPage(
  swell: SwellClient,
  page: number,
  { createdAfter, limit = DEFAULT_PAGE_SIZE }: SyncOptions = {},
): Promise<SyncPageResult> {
  if (!Number.isInteger(page) || page < 1) {
    throw new SyncError('Invalid page', 400);
  }
  limit = parsePageSize(limit);

  const { credentials } = await getAlgoliaSettings(swell);

  if (!credentials) {
    throw new SyncError('Missing Algolia Application ID or Admin API Key in app settings', 400);
  }

  if (page === 1 && !(await checkHasKeys(credentials))) {
    throw new SyncError('Invalid Application-ID or API key', 400);
  }

  const languages = await getLanguages(swell);
  const categoryLookup = await getCategoryLookup(swell);

  const products = await swell.get('/products', {
    ...productQuery(languages),
    ...(createdAfter ? { date_created: { $gte: createdAfter } } : {}),
    // stable order so pages don't shift while the sync walks them
    sort: 'date_created asc',
    limit,
    page,
  });

  const results: any[] = products?.results || [];
  const objectIDs = await saveObjects(
    credentials,
    results.map((product) => formatProduct(product, categoryLookup)),
  );
  const done = results.length < limit;

  if (done) {
    console.log(`Algolia: sync finished on page ${page}`);
  }

  return {
    page,
    limit,
    count: products?.count || 0,
    synced: objectIDs.length,
    done,
  };
}
