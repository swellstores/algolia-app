# Swell React + Vite template

A Swell app frontend based on Cloudflare's scaffold, with an application Worker and Swell managed hosting settings.

**Preview:** released Swell CLI integration and end-to-end deployment verification are pending. Local build and browser checks have passed with mocked platform responses; dev/tunnel context and real Swell sessions still need verification.

## CLI scaffolding preview

With the development Swell CLI that includes the managed template choices:

```sh
swell create app my-app -t admin --frontend swell-react -y
cd my-app
swell app frontend dev
# Deploy with a compatible managed-hosting platform:
swell app push
```

The CLI automatically finalizes the template, sets `frontend.hosting: managed`
in the parent `swell.json`, installs dependencies and generates Worker types.
Choose a package manager with `--pkg npm|yarn|pnpm|bun`. For an existing app, run
`swell create frontend --frontend swell-react -y` from its directory.

These commands require the development CLI; released CLI support and live
deployment/tunnel qualification are still pending. The standalone setup below
is for working directly on a copy of this template.

## Local evaluation

Use Node.js 22.22.2 and npm. Copy this directory to your working location and run the following commands from that directory:

```sh
npm run prepare:managed
npm ci
npm run cf-typegen
npm run typecheck
npm run lint
npm test
npm run build
```

`prepare:managed` restores the pinned dependency declarations and the supported Wrangler profile after C3 changes them. Run it once on a fresh template copy, before generating types or building; the Swell CLI already runs it during scaffolding. It then removes its command, script and snapshots so it cannot reset later application changes. It does not run on Swell's servers. The template targets compatibility date `2026-09-08`; keep it aligned with the managed platform profile.

Run `npm run dev` to start the local development server. Without Swell request context, the catalog cannot load platform data and `/app-api/context` returns an unavailable-context response. The public `/app-api/hello` endpoint can be exercised locally.

## Swell integration preview

For evaluation with a Swell CLI and platform build that support these managed templates, place this directory at `frontend/` inside a Swell app. Add `"hosting": "managed"` to the parent `swell.json` frontend configuration, preserving its other settings:

```json
{ "frontend": { "hosting": "managed" } }
```

The intended workflow is `swell app dev` for development through Swell and `swell app push` for deployment, both from the parent app. The frontend package contains the built Worker, public assets and serving settings. Managed deployment uses Swell's Cloudflare account. Dev/tunnel integration and fresh-template deployment remain pending verification; do not assume these commands work with the currently released CLI.

## Data and endpoints

Use `swell-js` directly for ordinary platform data exchange. The catalog example initializes it using public runtime context from `/app-api/context`; the example does not embed store/environment values during building. Backend API hosts and tokens are not part of public context.

- `/app-api/hello`: public example.
- `/app-api/context`: public request-time store configuration.
- `/app-api/admin/product-count`: fixed Backend API read. It validates `_swell_admin_session` through Swell and requires the session to belong to the current store. Its explicit example policy allows any validated staff session for this store to read the catalog count. Add operation-specific user permissions before exposing more privileged data.

The protected example returns only a count. Do not turn it into an unrestricted Backend API proxy. Credentials and sessions must never appear in responses, browser bundles or logs. Use non-GET methods and appropriate CSRF protection when adding cookie-authenticated mutations. Public pages remain accessible without a staff session.

Swell owns `/api`, `/functions`, GraphQL and existing platform paths. Use `/app-api` for frontend handlers. The gateway supplies trusted context in managed hosting; these examples are not an independently authenticated ingress for a self-hosted Worker.

## Assets and platform settings

Use the included `SwellImage` component with a product/content URL from `https://cdn.swell.store`. Use ordinary image tags for bundled files. No Cloudflare Images binding is used.

`public/_headers` marks hashed `/assets/*` immutable. Swell preserves browser caching as private; other responses stay no-store. The managed packager excludes sensitive files such as source maps, `.dev.vars`, dependency directories and build/serving configuration. Keep secrets and source files out of `public/`; local preview and direct Cloudflare deployment do not use Swell's packaging checks.

The managed profile supports only the `ASSETS` binding. Swell controls placement, CSP, CORS and cache policy. `/.swell/context` is reserved for the platform's public runtime context, and the `metadata` module name is reserved in packages. Managed runtime logs are not currently exposed; use local development for console debugging.
