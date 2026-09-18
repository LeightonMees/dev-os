// How an artifact should be carried over HTTP and shown in the UI.
// Driven by the file extension, not the artifact kind: kind says why the file
// exists ("report", "diff"), media says what it is ("image/png"). The viewer
// needs the second.

import { extname } from "node:path";

/** How the artifact zone can present a file. */
export type ArtifactMediaForm = "html" | "svg" | "image" | "markdown" | "pdf" | "text" | "binary";

export interface ArtifactMedia {
  /** Content-Type to serve the raw bytes with. */
  type: string;
  form: ArtifactMediaForm;
  /** True when the bytes are UTF-8 and may be shown and edited as text. */
  text: boolean;
}

const BINARY: ArtifactMedia = { type: "application/octet-stream", form: "binary", text: false };

const BY_EXT: Record<string, ArtifactMedia> = {
  ".html": { type: "text/html; charset=utf-8", form: "html", text: true },
  ".htm": { type: "text/html; charset=utf-8", form: "html", text: true },
  ".svg": { type: "image/svg+xml", form: "svg", text: true },
  ".md": { type: "text/markdown; charset=utf-8", form: "markdown", text: true },
  ".markdown": { type: "text/markdown; charset=utf-8", form: "markdown", text: true },
  ".pdf": { type: "application/pdf", form: "pdf", text: false },
  ".png": { type: "image/png", form: "image", text: false },
  ".jpg": { type: "image/jpeg", form: "image", text: false },
  ".jpeg": { type: "image/jpeg", form: "image", text: false },
  ".gif": { type: "image/gif", form: "image", text: false },
  ".webp": { type: "image/webp", form: "image", text: false },
  ".avif": { type: "image/avif", form: "image", text: false },
  ".bmp": { type: "image/bmp", form: "image", text: false },
  ".ico": { type: "image/x-icon", form: "image", text: false },
  ".css": { type: "text/css; charset=utf-8", form: "text", text: true },
  ".js": { type: "text/javascript; charset=utf-8", form: "text", text: true },
  ".mjs": { type: "text/javascript; charset=utf-8", form: "text", text: true },
  ".ts": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".tsx": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".json": { type: "application/json; charset=utf-8", form: "text", text: true },
  ".txt": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".log": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".diff": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".patch": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".csv": { type: "text/csv; charset=utf-8", form: "text", text: true },
  ".yml": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".yaml": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".xml": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".sh": { type: "text/plain; charset=utf-8", form: "text", text: true },
  ".glb": { type: "model/gltf-binary", form: "binary", text: false },
  ".gltf": { type: "model/gltf+json", form: "binary", text: false },
};

/** Media for a path. Unknown extensions are treated as opaque bytes. */
export function artifactMedia(path: string): ArtifactMedia {
  const ext = extname(path).toLowerCase();
  if (ext === "") return { type: "text/plain; charset=utf-8", form: "text", text: true };
  return BY_EXT[ext] ?? BINARY;
}

/** The syntax name for the code editor, or null when there is nothing to highlight. */
export function artifactLanguage(path: string): string | null {
  const ext = extname(path).toLowerCase();
  const byExt: Record<string, string> = {
    ".html": "html",
    ".htm": "html",
    ".svg": "xml",
    ".xml": "xml",
    ".css": "css",
    ".js": "javascript",
    ".mjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".json": "json",
    ".md": "markdown",
    ".markdown": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".sh": "shell",
  };
  return byExt[ext] ?? null;
}
