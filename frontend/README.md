# Algolia app frontend

The managed frontend of the Algolia Swell app: the **Products → Algolia sync** page in the Swell dashboard. See the [app README](../README.md) for features, settings, setup and limits.

- `src/ProductSync.tsx`: the sync page. Lets the merchant sync all products or only those created on or after a date, calls the Worker page by page, shows progress, supports stop and resume, and shows error details.
- `worker/index.ts`: routes `/app-api/*` requests; everything else is served from the built assets.
- `worker/swell-server.ts`: `POST /app-api/admin/sync` validates the staff session and same-origin JSON request, then syncs one page with `syncProductsPage` from `../functions/lib/algolia.ts`. `GET /app-api/context` returns public store context.

## Develop

Use the scripts from this folder or the app root:

```sh
npm run typecheck   # TypeScript for the page and the Worker
npm run lint
npm test            # Worker endpoint tests (vitest, run from the app root)
npm run build       # local build; `swell app push` rebuilds anyway
```

Deploy with `swell app push` from the app root. Do not deploy directly to Cloudflare.

`npm run dev` starts Vite locally, but without the Swell request context the sync endpoint cannot reach the store, so test the page in the store's test environment after `swell app push`.

## Rules for this Worker

- Backend credentials come from Swell request headers at request time and stay in the Worker. Never expose them to the browser or put store values in the build.
- Protected endpoints validate `_swell_admin_session` against Swell and only accept same-origin JSON for mutations.
- Frontend endpoints live under `/app-api`; Swell owns `/api`, `/functions` and other platform paths.
- Keep `dist/` and `.wrangler/` out of git: builds write local absolute paths into them.
