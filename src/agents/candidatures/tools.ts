import { z } from "zod";
import { defineTool, type AgentTool } from "../../core/tool";
import type { ApplicationHistory, SentApplication } from "./history";
import type { LaBonneBoiteClient } from "./labonneboite";
import type { Mailer } from "./mailer";

export const MAX_LETTER_LENGTH = 1500;

export type CandidaturesDeps = {
  laBonneBoite: LaBonneBoiteClient;
  mailer: Mailer;
  history: ApplicationHistory;
  /** Profil du candidat (CV résumé, liens), écrit par lui : la seule source de faits pour les lettres. */
  readProfile(): Promise<string>;
  /** CV joint à chaque candidature. */
  cvPath?: string;
  maxPerDay: number;
  now?: () => Date;
};

// Le SIREN (9 premiers chiffres du SIRET) identifie l'entreprise, quel que soit l'établissement.
const siren = (siret: string) => siret.replace(/\s/g, "").slice(0, 9);

function findPrevious(entries: SentApplication[], siret: string, to: string) {
  return entries.find(
    (entry) => siren(entry.siret) === siren(siret) || entry.to.toLowerCase() === to.toLowerCase(),
  );
}

const sendSchema = z.object({
  siret: z.string().regex(/^\d{14}$/, "SIRET à 14 chiffres, tel que renvoyé par search_companies"),
  companyName: z.string().min(1),
  to: z.email(),
  contactSource: z.url().describe("Page où l'adresse e-mail a été trouvée, pour que le candidat puisse vérifier"),
  subject: z.string().min(1).max(120),
  body: z.string().min(200).max(MAX_LETTER_LENGTH),
});

export function createCandidaturesTools(deps: CandidaturesDeps): AgentTool[] {
  const now = deps.now ?? (() => new Date());

  return [
    defineTool({
      name: "get_candidate_profile",
      description:
        "Lit le profil du candidat (parcours, compétences, projets, liens). C'est la seule source autorisée pour les faits cités dans une lettre.",
      schema: z.object({}),
      execute: async () => ({ profile: await deps.readProfile() }),
    }),

    defineTool({
      name: "search_companies",
      description:
        "Cherche sur La Bonne Boîte les entreprises susceptibles d'embaucher dans les 6 prochains mois, pour un métier et un lieu. " +
        "Ne renvoie ni e-mail ni site web : il faut les trouver ensuite. Les entreprises déjà contactées sont signalées.",
      schema: z.object({
        rome: z.array(z.string().regex(/^[A-N]\d{4}$/)).optional().describe("Codes ROME, ex. M1805 (études et développement informatique)"),
        job: z.string().optional().describe("Métier en texte libre, si aucun code ROME ne convient"),
        location: z.string().describe("Ville, département ou région, ex. « Nantes »"),
        page: z.number().int().min(1).optional(),
      }),
      async execute({ rome, job, location, page }) {
        const [{ hits, items }, sent] = await Promise.all([
          deps.laBonneBoite.search({ rome, job, location, page }),
          deps.history.list(),
        ]);
        return {
          hits,
          companies: items.map((company) => ({
            siret: company.siret,
            name: company.office_name || company.company_name,
            legalName: company.company_name,
            activity: company.naf_label,
            city: [company.postcode, company.city].filter(Boolean).join(" "),
            headcount: company.headcount_min && company.headcount_max ? `${company.headcount_min}-${company.headcount_max}` : null,
            hiringPotential: company.hiring_potential,
            highPotential: company.is_high_potential,
            alreadyContacted: sent.some((entry) => siren(entry.siret) === siren(company.siret)),
          })),
        };
      },
    }),

    defineTool({
      name: "list_sent_applications",
      description: "Liste les candidatures déjà envoyées (entreprise, adresse, date).",
      schema: z.object({}),
      execute: async () => ({ applications: await deps.history.list() }),
    }),

    defineTool({
      name: "send_application",
      description:
        `Envoie une candidature spontanée par e-mail depuis la boîte du candidat, CV en pièce jointe. ` +
        `Le candidat relit et valide chaque envoi. Lettre de ${MAX_LETTER_LENGTH} caractères au plus.`,
      schema: sendSchema,
      requiresApproval: true,
      async summarize({ companyName, siret, to, contactSource, subject, body }) {
        const previous = findPrevious(await deps.history.list(), siret, to);
        const warning = previous
          ? `\n⚠ Déjà contactée le ${previous.sentAt.slice(0, 10)} (${previous.to}) : l'envoi sera bloqué.`
          : "";
        return [
          `Candidature à ${companyName} (SIRET ${siret})`,
          `De : ${deps.mailer.from}  →  À : ${to}`,
          `Adresse trouvée sur : ${contactSource}`,
          `Objet : ${subject}`,
          `Pièce jointe : ${deps.cvPath ?? "aucune"}`,
          "",
          body,
          "",
          `(${body.length}/${MAX_LETTER_LENGTH} caractères)${warning}`,
        ].join("\n");
      },
      async execute({ siret, companyName, to, subject, body }) {
        const entries = await deps.history.list();
        const previous = findPrevious(entries, siret, to);
        if (previous) {
          throw new Error(`${companyName} a déjà reçu une candidature le ${previous.sentAt.slice(0, 10)}.`);
        }
        const today = now().toISOString().slice(0, 10);
        const sentToday = entries.filter((entry) => entry.sentAt.startsWith(today)).length;
        if (sentToday >= deps.maxPerDay) {
          throw new Error(`Limite de ${deps.maxPerDay} candidatures par jour atteinte. Reprendre demain.`);
        }

        const { messageId } = await deps.mailer.send({ to, subject, text: body, attachmentPath: deps.cvPath });
        await deps.history.add({ siret, companyName, to, subject, sentAt: now().toISOString() });
        return { sent: true, messageId, remainingToday: deps.maxPerDay - sentToday - 1 };
      },
    }),
  ];
}
