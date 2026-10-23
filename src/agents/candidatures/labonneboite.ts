// API La Bonne Boîte v2 (France Travail) : entreprises susceptibles d'embaucher dans les 6 prochains mois.
// Documentation : https://francetravail.io/produits-partages/catalogue/bonne-boite-v2/documentation
const API_URL = "https://api.francetravail.io/partenaire/labonneboite/v2";
const TOKEN_URL = "https://authentification-partenaire.francetravail.io/connexion/oauth2/access_token?realm=/partenaire";
const SCOPES = "api_labonneboitev2 search office";

export type SearchParams = {
  rome?: string[];
  job?: string;
  location?: string;
  page?: number;
  pageSize?: number;
};

/** Champs renvoyés par /recherche. L'API ne donne ni e-mail, ni téléphone, ni site web. */
export type Company = {
  siret: string;
  company_name: string;
  office_name: string | null;
  naf_label: string | null;
  city: string | null;
  postcode: string | null;
  headcount_min: string | null;
  headcount_max: string | null;
  hiring_potential: number | null;
  is_high_potential: boolean | null;
};

export type LaBonneBoiteClient = {
  search(params: SearchParams): Promise<{ hits: number; items: Company[] }>;
};

type Credentials = { clientId: string; clientSecret: string };

export function createLaBonneBoiteClient(credentials: Credentials, fetchImpl: typeof fetch = fetch): LaBonneBoiteClient {
  let token: { value: string; expiresAt: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;

    const response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        scope: SCOPES,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `France Travail refuse l'authentification (${response.status}) : vérifier l'identifiant, le secret et que l'application est abonnée à l'API La Bonne Boîte.`,
      );
    }

    const data = (await response.json()) as { access_token: string; expires_in: number };
    // Marge d'une minute pour ne pas envoyer un token qui expire pendant la requête.
    token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return token.value;
  }

  return {
    async search(params) {
      const query = new URLSearchParams();
      for (const code of params.rome ?? []) query.append("rome", code);
      if (params.job) query.set("job", params.job);
      if (params.location) query.set("location", params.location);
      query.set("page", String(params.page ?? 1));
      query.set("page_size", String(params.pageSize ?? 20));

      const response = await fetchImpl(`${API_URL}/recherche?${query}`, {
        headers: { Authorization: `Bearer ${await accessToken()}`, Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`Erreur API La Bonne Boîte (${response.status}) : ${await response.text()}`);

      const body = (await response.json()) as { hits: number | null; items: Company[] | null };
      return { hits: body.hits ?? 0, items: body.items ?? [] };
    },
  };
}

/** Client configuré par les variables d'environnement, vérifiées seulement au premier appel. */
export function laBonneBoiteClientFromEnv(): LaBonneBoiteClient {
  let client: LaBonneBoiteClient | undefined;
  return {
    async search(params) {
      if (!client) {
        const { FRANCE_TRAVAIL_CLIENT_ID, FRANCE_TRAVAIL_CLIENT_SECRET } = process.env;
        if (!FRANCE_TRAVAIL_CLIENT_ID || !FRANCE_TRAVAIL_CLIENT_SECRET) {
          throw new Error(
            "API La Bonne Boîte non configurée : FRANCE_TRAVAIL_CLIENT_ID et FRANCE_TRAVAIL_CLIENT_SECRET sont requis.",
          );
        }
        client = createLaBonneBoiteClient({
          clientId: FRANCE_TRAVAIL_CLIENT_ID,
          clientSecret: FRANCE_TRAVAIL_CLIENT_SECRET,
        });
      }
      return client.search(params);
    },
  };
}
