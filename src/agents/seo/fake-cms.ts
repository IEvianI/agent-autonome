// CMS simulé pour l'étape 1 : on enregistre les changements au lieu de modifier le vrai site.
// Étape 2 : brancher ici l'API du vrai CMS (WordPress, Shopify, ou une PR GitHub sur le repo du site).

export type MetaChange = { url: string; title?: string; metaDescription?: string };

export const publishedChanges: MetaChange[] = [];
