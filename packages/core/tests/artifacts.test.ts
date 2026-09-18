import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { artifactLanguage, artifactMedia } from "../src/index.ts";
import { openTestDev, tempRoot } from "./helpers.ts";

function seed(dev: ReturnType<typeof openTestDev>["dev"], name: string, body: string) {
  const dir = tempRoot();
  const path = join(dir, name);
  writeFileSync(path, body, "utf8");
  const project = dev.projects.add({ path: dir, name: "artifacts" });
  return { project, path };
}

test("revising an artifact writes a new version and never touches the original", () => {
  const { dev, cleanup } = openTestDev();
  try {
    const { project, path } = seed(dev, "page.html", "<h1>from the worker</h1>");
    const original = dev.artifacts.add({ projectId: project.id, kind: "report", name: "page", path });

    const v2 = dev.artifacts.revise(original.id, "<h1>edited by hand</h1>");

    assert.notEqual(v2.id, original.id);
    assert.notEqual(v2.path, original.path);
    assert.equal(readFileSync(original.path, "utf8"), "<h1>from the worker</h1>", "original untouched");
    assert.equal(readFileSync(v2.path, "utf8"), "<h1>edited by hand</h1>");
    assert.equal(v2.meta.rootId, original.id);
    assert.equal(v2.meta.version, 2);
    assert.equal(v2.meta.revisedFrom, original.id);
    assert.equal(v2.kind, original.kind, "kind carries over");
    assert.ok(v2.path.endsWith(".v2.html"), `version suffix kept the extension: ${v2.path}`);
  } finally {
    cleanup();
  }
});

test("versions returns the whole chain oldest first, and revising any version appends", () => {
  const { dev, cleanup } = openTestDev();
  try {
    const { project, path } = seed(dev, "notes.md", "one");
    const original = dev.artifacts.add({ projectId: project.id, kind: "document", name: "notes", path });
    const v2 = dev.artifacts.revise(original.id, "two");
    const v3 = dev.artifacts.revise(v2.id, "three");

    assert.deepEqual(
      dev.artifacts.versions(original.id).map((a) => a.id),
      [original.id, v2.id, v3.id],
    );
    assert.equal(v3.meta.rootId, original.id, "chain stays rooted at the original");
    assert.equal(v3.meta.version, 3);
  } finally {
    cleanup();
  }
});

test("revising an unknown artifact fails loudly", () => {
  const { dev, cleanup } = openTestDev();
  try {
    assert.throws(() => dev.artifacts.revise("art_nope", "x"), /Unknown artifact/);
  } finally {
    cleanup();
  }
});

test("media form is derived from the extension, and unknown bytes stay opaque", () => {
  assert.deepEqual(artifactMedia("a/b/page.html"), { type: "text/html; charset=utf-8", form: "html", text: true });
  assert.equal(artifactMedia("logo.SVG").form, "svg", "extension match is case-insensitive");
  assert.equal(artifactMedia("shot.png").form, "image");
  assert.equal(artifactMedia("shot.png").text, false);
  assert.equal(artifactMedia("readme.md").form, "markdown");
  assert.equal(artifactMedia("spec.pdf").type, "application/pdf");
  assert.equal(artifactMedia("run.log").form, "text");
  assert.equal(artifactMedia("execution-1").form, "text", "extensionless artifacts are logs");
  assert.equal(artifactMedia("mesh.glb").form, "binary", "meshes are carried but not claimed as viewable");
  assert.equal(artifactMedia("thing.sqlite").form, "binary");
});

test("editor language is only claimed where there is something to highlight", () => {
  assert.equal(artifactLanguage("page.html"), "html");
  assert.equal(artifactLanguage("logo.svg"), "xml");
  assert.equal(artifactLanguage("run.log"), null);
});
