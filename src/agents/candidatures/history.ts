import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type SentApplication = {
  siret: string;
  companyName: string;
  to: string;
  subject: string;
  sentAt: string;
};

/** Candidatures déjà envoyées : sert à ne jamais écrire deux fois à la même entreprise. */
export type ApplicationHistory = {
  list(): Promise<SentApplication[]>;
  add(application: SentApplication): Promise<void>;
};

export function memoryHistory(initial: SentApplication[] = []): ApplicationHistory {
  const entries = [...initial];
  return {
    async list() {
      return [...entries];
    },
    async add(application) {
      entries.push(application);
    },
  };
}

/** Fichier JSON local : un seul candidat, quelques centaines de lignes au plus. */
export function fileHistory(path: string): ApplicationHistory {
  async function list(): Promise<SentApplication[]> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as SentApplication[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  return {
    list,
    async add(application) {
      const entries = await list();
      entries.push(application);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(entries, null, 2));
    },
  };
}
