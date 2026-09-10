import * as cheerio from "cheerio";
import { z } from "zod";
import { defineTool, type ToolContext } from "../../core/tool";
import { publishedChanges } from "./fake-cms";

const pathSchema = z.string().startsWith("/").describe("Chemin de la page sur le site, ex : / ou /produits/tasse");

// Le site vient du contexte serveur, pas du modèle : une consigne cachée dans le HTML
// d'une page analysée ne peut pas envoyer l'agent vers un autre domaine.
function pageUrl(path: string, ctx: ToolContext): URL {
  if (!ctx.siteUrl) throw new Error("Aucun site configuré pour cette session.");
  const site = new URL(ctx.siteUrl);
  const url = new URL(path, site);
  if (url.origin !== site.origin) throw new Error(`Refusé : ${url.href} est hors du site ${site.origin}.`);
  return url;
}

export const analyzePage = defineTool({
  name: "analyze_page",
  description:
    "Télécharge une page du site et en extrait les éléments SEO : title, meta description, titres h1, " +
    "balise canonical, langue et nombre d'images sans texte alternatif.",
  schema: z.object({ path: pathSchema }),
  execute: async ({ path }, ctx) => {
    const url = pageUrl(path, ctx);
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (new URL(response.url).origin !== url.origin) {
      throw new Error(`Refusé : la page redirige hors du site (${response.url}).`);
    }

    const $ = cheerio.load(await response.text());
    const title = $("title").first().text().trim();
    const metaDescription = $('meta[name="description"]').attr("content")?.trim() ?? "";

    // On renvoie un résumé et pas le HTML brut : moins de tokens, et moins de texte arbitraire dans le contexte.
    return {
      url: response.url,
      status: response.status,
      title,
      titleLength: title.length,
      metaDescription,
      metaDescriptionLength: metaDescription.length,
      h1: $("h1").map((_, el) => $(el).text().trim()).get(),
      canonical: $('link[rel="canonical"]').attr("href") ?? null,
      lang: $("html").attr("lang") ?? null,
      imagesWithoutAlt: $("img:not([alt])").length,
    };
  },
});

export const applyMetaChanges = defineTool({
  name: "apply_meta_changes",
  description:
    "Publie un nouveau title et/ou une nouvelle meta description pour une page du site. " +
    "Action critique soumise à validation humaine.",
  schema: z.object({
    path: pathSchema,
    title: z.string().max(60).optional(),
    metaDescription: z.string().max(160).optional(),
    reason: z.string().describe("Pourquoi ce changement améliore le référencement, en une phrase."),
  }),
  requiresApproval: true,
  summarize: ({ path, title, metaDescription, reason }, ctx) =>
    [
      `Modifier ${ctx.siteUrl}${path}`,
      title && `title → « ${title} »`,
      metaDescription && `description → « ${metaDescription} »`,
      `Motif : ${reason}`,
    ]
      .filter(Boolean)
      .join(" · "),
  execute: async ({ path, title, metaDescription }, ctx) => {
    const url = pageUrl(path, ctx);
    if (!title && !metaDescription) throw new Error("Rien à modifier : fournir un title ou une meta description.");
    publishedChanges.push({ url: url.href, title, metaDescription });
    return { published: true, url: url.href, title, metaDescription };
  },
});
