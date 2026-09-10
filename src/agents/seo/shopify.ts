const API_VERSION = "2026-07";

export type ShopifyClient = {
  graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T>;
};

type Credentials = { shop: string; clientId: string; clientSecret: string };

export function createShopifyClient(credentials: Credentials, fetchImpl: typeof fetch = fetch): ShopifyClient {
  const shop = credentials.shop.replace(/^https?:\/\//, "").replace(/\.myshopify\.com\/?$/, "");
  const adminUrl = `https://${shop}.myshopify.com/admin`;
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;

    const response = await fetchImpl(`${adminUrl}/oauth/access_token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `Shopify refuse l'authentification (${response.status}) : vérifier que l'app est installée sur ${shop} et appartient à la même organisation.`,
      );
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    // Le token vit 24 h : on le garde en mémoire et on le renouvelle 5 minutes avant l'expiration.
    token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 };
    return token.value;
  }

  return {
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      const response = await fetchImpl(`${adminUrl}/api/${API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await accessToken() },
        body: JSON.stringify({ query, variables }),
      });
      if (!response.ok) throw new Error(`Erreur API Shopify (${response.status}).`);

      const body = (await response.json()) as { data?: T; errors?: { message: string }[] };
      if (body.errors?.length) {
        throw new Error(`Erreur GraphQL Shopify : ${body.errors.map((error) => error.message).join(" ; ")}`);
      }
      return body.data as T;
    },
  };
}

/** Client configuré par les variables d'environnement, vérifiées seulement au premier appel. */
export function shopifyClientFromEnv(): ShopifyClient {
  let client: ShopifyClient | undefined;
  return {
    async graphql<T>(query: string, variables?: Record<string, unknown>) {
      if (!client) {
        const { SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET } = process.env;
        if (!SHOPIFY_SHOP || !SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
          throw new Error(
            "Connexion Shopify non configurée : SHOPIFY_SHOP, SHOPIFY_CLIENT_ID et SHOPIFY_CLIENT_SECRET sont requis.",
          );
        }
        client = createShopifyClient({
          shop: SHOPIFY_SHOP,
          clientId: SHOPIFY_CLIENT_ID,
          clientSecret: SHOPIFY_CLIENT_SECRET,
        });
      }
      return client.graphql<T>(query, variables);
    },
  };
}
