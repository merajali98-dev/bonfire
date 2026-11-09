import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { briefKey, parseBrief, sha256Hex } from "../src/brief-text.ts";

const REPO = "https://github.com/merajali98-dev/bonfire/blob/main/";
const ROOT = join(import.meta.dirname, "../../..");

test("only brief files on a repository's main branch are treated as local", () => {
  assert.equal(briefKey(`${REPO}docs/briefs/round-1/sticker-pack.md`), "docs/briefs/round-1/sticker-pack.md");
  assert.equal(briefKey(`${REPO}docs/briefs/demo.md`), "docs/briefs/demo.md");
  for (const uri of ["https://example.test/docs/briefs/demo.md", `${REPO}README.md`, `${REPO}docs/briefs/../../README.md`, `${REPO}docs/briefs/a.txt`, "javascript:alert(1)", ""]) {
    assert.equal(briefKey(uri), null, uri);
  }
});

test("the page hashes text the way the nomination script hashes the file", async () => {
  const path = join(ROOT, "docs/briefs/round-1/sticker-pack.md");
  const bytes = readFileSync(path);
  assert.equal(await sha256Hex(bytes.toString("utf-8")), createHash("sha256").update(bytes).digest("hex"));
});

test("a brief parses into a heading, paragraphs and lists", () => {
  const blocks = parseBrief("# Title\n\n**Delivered by:** a team.\n\nSome text\nover two lines.\n\n**Deliver:**\n\n- One\n- Two **bold** end\n");
  assert.deepEqual(blocks[0], { type: "heading", text: "Title" });
  assert.deepEqual(blocks[1], { type: "paragraph", runs: [{ text: "Delivered by:", bold: true }, { text: " a team.", bold: false }] });
  assert.deepEqual(blocks[2], { type: "paragraph", runs: [{ text: "Some text over two lines.", bold: false }] });
  assert.deepEqual(blocks[4], { type: "list", items: [[{ text: "One", bold: false }], [{ text: "Two ", bold: false }, { text: "bold", bold: true }, { text: " end", bold: false }]] });
});

test("every real brief has a title and no unparsed markup", () => {
  const dirs = [join(ROOT, "docs/briefs"), join(ROOT, "docs/briefs/round-1")];
  for (const dir of dirs) {
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const blocks = parseBrief(readFileSync(join(dir, name), "utf-8"));
      assert.equal(blocks[0].type, "heading", name);
      assert.ok(!JSON.stringify(blocks).includes("**"), name);
    }
  }
});
