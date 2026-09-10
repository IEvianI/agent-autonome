import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMetaChanges, analyzePage } from "./tools";

const ctx = { siteUrl: "https://boutique.test" };

test("analyze_page refuse une URL hors du site de la session", async () => {
  await assert.rejects(analyzePage.execute({ path: "//attaquant.test/page" }, ctx), /hors du site/);
});

test("apply_meta_changes rejette un title trop long avant toute validation", () => {
  const parsed = applyMetaChanges.schema.safeParse({ path: "/", title: "x".repeat(61), reason: "test" });
  assert.equal(parsed.success, false);
});
