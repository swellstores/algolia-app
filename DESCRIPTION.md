Give shoppers fast, typo-tolerant search. This app keeps your Swell products in an Algolia index, so your storefront search reflects your catalog as it changes.

Connect your Algolia account, then send your catalog to Algolia from a page in your Swell dashboard. From then on, every product you create, edit, deactivate or delete in Swell is updated in Algolia within moments. Your storefront searches Algolia directly, for example with Algolia's InstantSearch library and a Search-Only API key.

- **Always current.** Active products are sent to Algolia when they're created or edited, and a product you deactivate or delete is removed from search. One setting turns automatic updates off if you need to.
- **Your catalog on demand.** Products → Algolia sync sends all your active products, or only those created on or after a date you pick. Choose how many products go in each request, follow the progress, and stop or resume from the next page at any time.
- **Records built for search.** Each product is indexed with its name, description, price, SKU, images, stock status and attributes, plus the full path of every category it's in, ready for category filters and Algolia's hierarchical menus. Stores with more than one language get translated fields too.
- **Your keys stay on the server.** The Admin API Key is used only on Swell's servers to write to your index. It's never sent to a browser.

**Replaces the built-in integration.** If your store uses Swell's built-in Algolia integration, switch to this app rather than running both, so products aren't sent to Algolia twice.

Setup takes a few minutes. Copy your Application ID and Admin API Key from Algolia → Settings → API Keys, paste them into the app settings and choose an index name (`products` by default). Then open Products → Algolia sync and click Start sync. Keep the page open until it shows Complete.
