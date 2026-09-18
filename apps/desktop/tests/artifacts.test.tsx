import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactCanvas, clampZoom, defaultPlacement, loadLayout, layoutKey, type Board } from "../src/components/ArtifactCanvas.tsx";
import { ArtifactEditor } from "../src/components/ArtifactEditor.tsx";
import { ArtifactPreview, parseMarkdown } from "../src/components/ArtifactPreview.tsx";
import { boardForm } from "../src/views/ArtifactsView.tsx";
import type { Artifact, ArtifactContent } from "../src/lib/api.ts";

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "art_1",
    projectId: "prj_1",
    taskId: null,
    executionId: null,
    kind: "report",
    name: "page",
    path: "C:/tmp/page.html",
    size: 21,
    createdAt: new Date().toISOString(),
    meta: {},
    ...over,
  } as Artifact;
}

function head(over: Partial<ArtifactContent> = {}): ArtifactContent {
  return {
    artifact: artifact(),
    media: { type: "text/html; charset=utf-8", form: "html", text: true },
    language: "html",
    versions: 1,
    content: "<h1>hello</h1>",
    truncated: false,
    editable: true,
    ...over,
  };
}

describe("artifact preview", () => {
  it("renders HTML in a sandbox that cannot reach the app's origin", () => {
    const { container } = render(<ArtifactPreview head={head()} rawUrl="http://cp/api/artifacts/art_1/raw" />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("srcdoc")).toBe("<h1>hello</h1>");
    const sandbox = frame.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("shows the unsaved draft so an edit can be judged before it is saved", () => {
    const { container } = render(<ArtifactPreview head={head()} rawUrl="http://cp/raw" draft="<h1>edited</h1>" />);
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toBe("<h1>edited</h1>");
  });

  it("loads images from the raw endpoint rather than inlining them", () => {
    const h = head({ artifact: artifact({ name: "shot", path: "C:/tmp/shot.png" }), media: { type: "image/png", form: "image", text: false }, content: "", editable: false });
    const { container } = render(<ArtifactPreview head={h} rawUrl="http://cp/api/artifacts/art_1/raw" />);
    expect(container.querySelector("img")!.getAttribute("src")).toBe("http://cp/api/artifacts/art_1/raw");
  });

  it("says plainly that a mesh is not drawn rather than showing an empty frame", () => {
    const h = head({ artifact: artifact({ name: "prop.glb", path: "C:/tmp/prop.glb" }), media: { type: "model/gltf-binary", form: "binary", text: false }, content: "", editable: false });
    render(<ArtifactPreview head={h} rawUrl="http://cp/raw" />);
    expect(screen.getByText(/no viewport for them in this build/i)).toBeTruthy();
  });
});

describe("markdown blocks", () => {
  it("reads headings, fences and lists, and keeps paragraph text", () => {
    const blocks = parseMarkdown("# Title\n\nsome *text* here\n\n- one\n- two\n\n```\ncode()\n```\n");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "code"]);
    expect(blocks[0]).toMatchObject({ level: 1, text: "Title" });
    expect(blocks[3]).toMatchObject({ text: "code()" });
  });
});

describe("artifact editor", () => {
  it("refuses to save a truncated file and says why", () => {
    render(<ArtifactEditor head={head({ truncated: true, editable: false })} draft="changed" onDraft={() => {}} onSave={() => {}} saving={false} />);
    const save = screen.getByRole("button", { name: /save version/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/saving would drop the rest/i)).toBeTruthy();
  });

  it("enables saving only once the draft differs from what was loaded", () => {
    const { rerender } = render(<ArtifactEditor head={head()} draft="<h1>hello</h1>" onDraft={() => {}} onSave={() => {}} saving={false} />);
    expect((screen.getByRole("button", { name: /save version/i }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ArtifactEditor head={head()} draft="<h1>changed</h1>" onDraft={() => {}} onSave={() => {}} saving={false} />);
    expect((screen.getByRole("button", { name: /save version/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("canvas", () => {
  const boards: Board[] = [
    { artifact: artifact({ id: "a1", name: "one" }), form: "html", rawUrl: "http://cp/a1" },
    { artifact: artifact({ id: "a2", name: "two", path: "C:/tmp/shot.png" }), form: "image", rawUrl: "http://cp/a2" },
  ];

  it("lays boards out in a stable grid", () => {
    expect(defaultPlacement(0)).toEqual({ x: 0, y: 0 });
    expect(defaultPlacement(1).x).toBeGreaterThan(0);
    expect(defaultPlacement(3)).toEqual({ x: 0, y: defaultPlacement(3).y });
    expect(defaultPlacement(3).y).toBeGreaterThan(0);
  });

  it("clamps zoom so the canvas cannot be lost off-scale", () => {
    expect(clampZoom(99)).toBe(2.5);
    expect(clampZoom(0.001)).toBe(0.2);
    expect(clampZoom(1)).toBe(1);
  });

  it("ignores stored layout that is not a pair of numbers", () => {
    window.localStorage.setItem(layoutKey("prj_1"), JSON.stringify({ a1: { x: 10, y: 20 }, a2: { x: "left" }, a3: null }));
    expect(loadLayout("prj_1")).toEqual({ a1: { x: 10, y: 20 } });
    window.localStorage.setItem(layoutKey("prj_2"), "not json");
    expect(loadLayout("prj_2")).toEqual({});
  });

  it("draws an artboard per artifact and marks the selected one", () => {
    const { container } = render(<ArtifactCanvas projectId="prj_1" boards={boards} selectedId="a2" onSelect={() => {}} onOpen={() => {}} />);
    expect(container.querySelectorAll(".artboard").length).toBe(2);
    expect(container.querySelectorAll(".artboard.selected").length).toBe(1);
    expect(screen.getByText("2 artboards")).toBeTruthy();
  });

  it("keeps artboard thumbnails fully sandboxed, matching what the raw endpoint enforces", () => {
    const { container } = render(<ArtifactCanvas projectId="prj_1" boards={boards} selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("src")).toBe("http://cp/a1");
  });

  it("says the canvas is empty rather than showing a blank surface", () => {
    render(<ArtifactCanvas projectId="prj_1" boards={[]} selectedId={null} onSelect={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/nothing to lay out yet/i)).toBeTruthy();
  });
});

describe("which artifacts reach the canvas", () => {
  it("draws pages, drawings and images, and leaves logs and diffs out", () => {
    expect(boardForm("C:/a/page.html")).toBe("html");
    expect(boardForm("C:/a/logo.SVG")).toBe("svg");
    expect(boardForm("C:/a/shot.png")).toBe("image");
    expect(boardForm("C:/a/run.log")).toBe(null);
    expect(boardForm("C:/a/change.diff")).toBe(null);
  });
});
