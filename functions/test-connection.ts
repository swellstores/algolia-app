import { AlgoliaError, algoliaRequest, getAlgoliaSettings } from './lib/algolia';

export const config: SwellConfig = {
  description: 'Check the Algolia Application ID, Admin API Key and index',
  action: true,
};

// a thrown 400 shows in the admin as a red error popup, a returned message as a regular one
function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

export default async function (req: SwellRequest) {
  const { credentials } = await getAlgoliaSettings(req.swell);
  if (!credentials) {
    fail('Add the Application ID and Admin API Key and save the settings first.');
  }
  const { appId, indexName } = credentials;

  let records: number | undefined;
  try {
    // the product sync starts with the same check: listing API keys needs the Admin API Key
    await algoliaRequest(credentials, 'GET', '/1/keys');
    try {
      const result = await algoliaRequest(credentials, 'GET', `/1/indexes/${encodeURIComponent(indexName)}?hitsPerPage=0`);
      records = Number(result?.nbHits) || 0;
    } catch (err) {
      // a missing index is fine: the first sync creates it
      if (!(err instanceof AlgoliaError && err.status === 404)) throw err;
    }
  } catch (err) {
    if (err instanceof AlgoliaError && /invalid application-id or api key/i.test(err.message)) {
      fail("Algolia didn't accept the Application ID and Admin API Key. Copy both again from Algolia → Settings → API Keys.");
    }
    if (err instanceof AlgoliaError && err.status === 403) {
      fail('Algolia accepted the key, but it is not the Admin API Key. Copy the Admin API Key from Algolia → Settings → API Keys.');
    }
    if (err instanceof AlgoliaError) {
      fail(err.message);
    }
    fail(`Algolia couldn't be reached for the Application ID ${appId}. Check the Application ID, or try again in a minute.`);
  }

  if (records === undefined) {
    return {
      message: `Connected to Algolia application ${appId}. The index ${indexName} doesn't exist yet; Products → Algolia sync creates it.`,
    };
  }
  return {
    message: `Connected to Algolia application ${appId}, index ${indexName} (${records.toLocaleString('en-US')} ${records === 1 ? 'record' : 'records'}).`,
  };
}
