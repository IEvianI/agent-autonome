import assert from "node:assert/strict";
import { test } from "node:test";
import type { ShopifyClient } from "./shopify";
import { createSeoTools } from "./tools";

// Fausse API Shopify : répond selon le nom de l'opération GraphQL et garde la trace des appels.
function fakeShopify(responses: Record<string, unknown>) {
  const calls: { operation: string; variables?: Record<string, unknown> }[] = [];
  const client: ShopifyClient = {
    async graphql<T>(query: string, variables?: Record<string, unknown>) {
      const operation = query.match(/(?:query|mutation) (\w+)/)?.[1] ?? "";
      calls.push({ operation, variables });
      if (!(operation in responses)) throw new Error(`Opération non prévue : ${operation}`);
      return responses[operation] as T;
    },
  };
  return { client, calls };
}

const updateProductSeo = (client: ShopifyClient) =>
  createSeoTools(client).find((tool) => tool.name === "update_product_seo")!;

const productId = "gid://shopify/Product/1";
const currentProduct = { resource: { title: "T-shirt Lin", seo: { title: null, description: "Ancienne description" } } };

test("le résumé de validation montre l'avant et l'après", async () => {
  const { client } = fakeShopify({ ProductSeo: currentProduct });

  const summary = await updateProductSeo(client).summarize(
    { id: productId, seoTitle: "T-shirt en lin | CréaD", reason: "Title SEO vide" },
    {},
  );

  assert.match(summary, /Produit « T-shirt Lin »/);
  assert.match(summary, /title SEO : \(vide\) → « T-shirt en lin \| CréaD »/);
});

test("un champ non fourni garde sa valeur actuelle", async () => {
  const { client, calls } = fakeShopify({
    ProductSeo: currentProduct,
    UpdateProductSeo: {
      result: { resource: { seo: { title: "Nouveau", description: "Ancienne description" } }, userErrors: [] },
    },
  });

  const result = await updateProductSeo(client).execute({ id: productId, seoTitle: "Nouveau", reason: "test" }, {});

  assert.deepEqual(calls.at(-1), {
    operation: "UpdateProductSeo",
    variables: { input: { id: productId, seo: { title: "Nouveau", description: "Ancienne description" } } },
  });
  assert.deepEqual(result, {
    id: productId,
    before: { title: null, description: "Ancienne description" },
    after: { title: "Nouveau", description: "Ancienne description" },
  });
});

test("une erreur renvoyée par Shopify fait échouer l'outil", async () => {
  const { client } = fakeShopify({
    ProductSeo: currentProduct,
    UpdateProductSeo: { result: { resource: null, userErrors: [{ field: ["seo"], message: "Title is invalid" }] } },
  });

  await assert.rejects(
    updateProductSeo(client).execute({ id: productId, seoTitle: "Nouveau", reason: "test" }, {}),
    /Shopify a refusé la modification : Title is invalid/,
  );
});

test("l'outil produit refuse un identifiant d'un autre type de ressource", () => {
  const { client } = fakeShopify({});
  const parsed = updateProductSeo(client).schema.safeParse({
    id: "gid://shopify/Customer/1",
    seoTitle: "x",
    reason: "x",
  });
  assert.equal(parsed.success, false);
});
