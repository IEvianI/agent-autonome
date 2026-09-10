import { z } from "zod";
import { defineTool, type AgentTool } from "../../core/tool";
import type { ShopifyClient } from "./shopify";

type Seo = { title: string | null; description: string | null };
type UserError = { field: string[] | null; message: string };

const LIST_LIMIT = 50;

const PRODUCTS_QUERY = `query ProductsSeo($first: Int!) {
  products(first: $first, sortKey: TITLE) {
    nodes { id title handle status description seo { title description } media(first: 20) { nodes { alt } } }
    pageInfo { hasNextPage }
  }
}`;

const COLLECTIONS_QUERY = `query CollectionsSeo($first: Int!) {
  collections(first: $first, sortKey: TITLE) {
    nodes { id title handle description seo { title description } }
    pageInfo { hasNextPage }
  }
}`;

// Les alias GraphQL (resource, result) donnent la même forme de réponse aux produits et aux collections.
const SEO_TARGETS = {
  product: {
    label: "Produit",
    idPrefix: "gid://shopify/Product/",
    read: `query ProductSeo($id: ID!) { resource: product(id: $id) { title seo { title description } } }`,
    update: `mutation UpdateProductSeo($input: ProductUpdateInput!) {
      result: productUpdate(product: $input) { resource: product { seo { title description } } userErrors { field message } }
    }`,
  },
  collection: {
    label: "Collection",
    idPrefix: "gid://shopify/Collection/",
    read: `query CollectionSeo($id: ID!) { resource: collection(id: $id) { title seo { title description } } }`,
    update: `mutation UpdateCollectionSeo($input: CollectionUpdateInput!) {
      result: collectionUpdate(collection: $input) { resource: collection { seo { title description } } userErrors { field message } }
    }`,
  },
};

const show = (value: string | null | undefined) => (value ? `« ${value} »` : "(vide)");

function seoUpdateTool(shopify: ShopifyClient, kind: keyof typeof SEO_TARGETS): AgentTool {
  const target = SEO_TARGETS[kind];

  async function readCurrent(id: string) {
    const data = await shopify.graphql<{ resource: { title: string; seo: Seo } | null }>(target.read, { id });
    if (!data.resource) throw new Error(`${target.label} introuvable : ${id}`);
    return data.resource;
  }

  return defineTool({
    name: `update_${kind}_seo`,
    description:
      `Modifie le title et/ou la description SEO (affichés dans Google) d'un élément de type ${target.label.toLowerCase()}. ` +
      "Un champ non fourni reste inchangé. Action critique soumise à validation humaine.",
    schema: z.object({
      id: z.string().startsWith(target.idPrefix).describe(`Identifiant Shopify, ex : ${target.idPrefix}123`),
      seoTitle: z.string().min(1).max(60).optional(),
      seoDescription: z.string().min(1).max(160).optional(),
      reason: z.string().describe("Pourquoi ce changement améliore le référencement, en une phrase."),
    }),
    requiresApproval: true,
    summarize: async ({ id, seoTitle, seoDescription, reason }) => {
      const current = await readCurrent(id);
      return [
        `${target.label} « ${current.title} »`,
        seoTitle !== undefined && `title SEO : ${show(current.seo.title)} → ${show(seoTitle)}`,
        seoDescription !== undefined && `description SEO : ${show(current.seo.description)} → ${show(seoDescription)}`,
        `Motif : ${reason}`,
      ]
        .filter(Boolean)
        .join("\n   ");
    },
    execute: async ({ id, seoTitle, seoDescription }) => {
      if (seoTitle === undefined && seoDescription === undefined) {
        throw new Error("Rien à modifier : fournir seoTitle ou seoDescription.");
      }
      const before = await readCurrent(id);
      // On envoie les deux champs pour qu'un champ non fourni garde sa valeur actuelle.
      const seo = { title: seoTitle ?? before.seo.title, description: seoDescription ?? before.seo.description };

      const data = await shopify.graphql<{
        result: { resource: { seo: Seo } | null; userErrors: UserError[] };
      }>(target.update, { input: { id, seo } });

      const { userErrors, resource } = data.result;
      if (userErrors.length > 0) {
        throw new Error(`Shopify a refusé la modification : ${userErrors.map((e) => e.message).join(" ; ")}`);
      }
      // L'ancienne valeur reste dans l'historique du thread : de quoi revenir en arrière.
      return { id, before: before.seo, after: resource?.seo };
    },
  });
}

export function createSeoTools(shopify: ShopifyClient): AgentTool[] {
  const listProductsSeo = defineTool({
    name: "list_products_seo",
    description:
      "Liste les produits avec leurs champs SEO actuels, leur description et le nombre d'images sans texte alternatif. " +
      "Un champ SEO vide signifie que Google affiche le nom et la description bruts du produit.",
    schema: z.object({}),
    execute: async () => {
      const data = await shopify.graphql<{
        products: {
          nodes: {
            id: string;
            title: string;
            handle: string;
            status: string;
            description: string;
            seo: Seo;
            media: { nodes: { alt: string | null }[] };
          }[];
          pageInfo: { hasNextPage: boolean };
        };
      }>(PRODUCTS_QUERY, { first: LIST_LIMIT });

      return {
        products: data.products.nodes.map(({ media, description, ...product }) => ({
          ...product,
          description: description.slice(0, 1000),
          imagesWithoutAlt: media.nodes.filter((image) => !image.alt).length,
        })),
        truncated: data.products.pageInfo.hasNextPage,
      };
    },
  });

  const listCollectionsSeo = defineTool({
    name: "list_collections_seo",
    description: "Liste les collections avec leurs champs SEO actuels et leur description.",
    schema: z.object({}),
    execute: async () => {
      const data = await shopify.graphql<{
        collections: {
          nodes: { id: string; title: string; handle: string; description: string; seo: Seo }[];
          pageInfo: { hasNextPage: boolean };
        };
      }>(COLLECTIONS_QUERY, { first: LIST_LIMIT });

      return {
        collections: data.collections.nodes.map((c) => ({ ...c, description: c.description.slice(0, 1000) })),
        truncated: data.collections.pageInfo.hasNextPage,
      };
    },
  });

  return [
    listProductsSeo,
    listCollectionsSeo,
    seoUpdateTool(shopify, "product"),
    seoUpdateTool(shopify, "collection"),
  ];
}
