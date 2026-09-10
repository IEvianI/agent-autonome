import assert from "node:assert/strict";
import { test } from "node:test";
import { createShopifyClient } from "./shopify";

const credentials = { shop: "cread-test.myshopify.com", clientId: "id", clientSecret: "secret" };

function fakeFetch(graphqlResponse: unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith("/oauth/access_token")) {
      return Response.json({ access_token: "token-test", expires_in: 86399 });
    }
    return Response.json(graphqlResponse);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

test("le token est demandé une seule fois puis réutilisé", async () => {
  const { fetchImpl, urls } = fakeFetch({ data: { shop: { name: "cread-test" } } });
  const shopify = createShopifyClient(credentials, fetchImpl);

  await shopify.graphql("query A { shop { name } }");
  await shopify.graphql("query B { shop { name } }");

  assert.equal(urls.filter((url) => url.endsWith("/oauth/access_token")).length, 1);
  assert.equal(urls.at(-1), "https://cread-test.myshopify.com/admin/api/2026-07/graphql.json");
});

test("les erreurs GraphQL sont remontées", async () => {
  const { fetchImpl } = fakeFetch({ errors: [{ message: "Field 'foo' doesn't exist" }] });
  const shopify = createShopifyClient(credentials, fetchImpl);

  await assert.rejects(shopify.graphql("query A { foo }"), /Field 'foo' doesn't exist/);
});
