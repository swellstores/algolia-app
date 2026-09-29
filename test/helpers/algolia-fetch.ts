import { vi } from "vitest";

export type FetchCall = { method: string; url: URL; body: any; headers: Record<string, string> };
type Handler = (call: FetchCall) => Response | Promise<Response>;

// Stubs global fetch (used by the Algolia REST client) and records every call.
// `routes` maps "METHOD host/path" (host without the app id prefix for Algolia, e.g.
// "POST algolia/1/indexes/products/batch") to a handler; unmatched calls fail the test.
export function mockFetch(routes: Record<string, Handler | Response> = {}) {
  const calls: FetchCall[] = [];

  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (init.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit).forEach((value, name) => {
      headers[name] = value;
    });
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, url, body, headers };
    calls.push(call);

    const host = /algolia(net)?\.(net|com)$/.test(url.hostname) ? "algolia" : url.hostname;
    const key = `${method} ${host}${url.pathname}`;
    const route = routes[key];
    if (!route) {
      throw new Error(`Unexpected fetch ${key}`);
    }
    return typeof route === "function" ? route(call) : route.clone();
  });

  return { calls, spy };
}

// Algolia batch endpoint that echoes the objectIDs it received; addObject gets a generated id
export const echoBatch: Handler = ({ body }) =>
  Response.json({
    objectIDs: body.requests.map((request: any, index: number) => request.body.objectID ?? `generated-${index}`),
  });

export const algoliaSettings = {
  algolia: {
    api_application_id: "APPID",
    api_admin_key: "admin-key",
    index_name: "products",
    enabled: true,
  },
};
