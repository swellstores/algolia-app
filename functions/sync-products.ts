import { AlgoliaError, SyncError, parseCreatedAfter, parsePageSize, syncProductsPage } from './lib/algolia';

// Each call pushes one page of products. The app frontend drives the full sync
// page by page, so a single call stays within the function timeout.
export const config: SwellConfig = {
  description: 'Push one page of active products to Algolia',
  route: {
    methods: ['post'],
    public: false,
  },
};

export async function post(req: SwellRequest) {
  const page = Number(req.data?.page) || 1;

  try {
    const createdAfter = parseCreatedAfter(req.data?.created_after);
    const limit = parsePageSize(req.data?.limit);
    return await syncProductsPage(req.swell, page, { createdAfter, limit });
  } catch (err: any) {
    if (err instanceof SyncError) {
      throw new SwellError(err.message, { status: err.status });
    }
    console.error(`Algolia: sync failed on page ${page}`, err);
    throw new SwellError(err?.message || String(err), {
      status: err instanceof AlgoliaError && err.status < 500 ? 400 : 502,
    });
  }
}
