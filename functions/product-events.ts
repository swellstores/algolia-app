import {
  AlgoliaError,
  deleteObject,
  formatProduct,
  getAlgoliaSettings,
  getCategoryLookup,
  getLanguages,
  productQuery,
  saveObject,
} from './lib/algolia';

export const config: SwellConfig = {
  description: 'Sync product changes to Algolia',
  model: {
    events: ['product.created', 'product.updated', 'product.deleted'],
  },
};

export default async function (req: SwellRequest) {
  try {
    await handleProductEvent(req);
  } catch (err) {
    // 4xx from Algolia (bad key, missing rights, invalid record) won't succeed on retry
    if (err instanceof AlgoliaError && err.status < 500) {
      throw new SwellError(err.message, { status: err.status, retry: false });
    }
    throw err;
  }
}

async function handleProductEvent(req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const { settings, credentials } = await getAlgoliaSettings(swell);

  if (settings.enabled === false) {
    return;
  }

  if (!credentials) {
    console.error('Algolia: missing required settings (api_application_id, api_admin_key)');
    return;
  }

  // remove a product from Algolia when it is deleted or deactivated
  if (
    eventType === 'product.deleted' ||
    (eventType === 'product.updated' && data.active === false)
  ) {
    await deleteObject(credentials, data.id);
    console.log(`Algolia: deleted product ${data.id} from "${credentials.indexName}"`);
    return;
  }

  const languages = await getLanguages(swell);
  const product = await swell.get(`/products/${data.id}`, productQuery(languages));

  if (!product) {
    // inactive products are not returned because of the active: true filter
    console.log(`Algolia: product ${data.id} not found to be sent to Algolia`);
    return;
  }

  const categoryLookup = await getCategoryLookup(swell);

  await saveObject(credentials, formatProduct(product, categoryLookup));
  console.log(`Algolia: sent product ${data.id} to "${credentials.indexName}"`);
}
