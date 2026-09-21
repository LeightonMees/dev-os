import { useMemo } from "react";

import type { ArtifactContent } from "../lib/api.ts";
import { ModelViewer } from "./ModelViewer.tsx";

/**
 * Artifact output rendered as what it actually is. The bytes come from a
 * worker, so every rendered form is isolated: iframes get `sandbox` without
 * `allow-same-origin`, which puts the content on an opaque origin where it
 * cannot read the control plane, our storage, or the rest of the app.
 */
export function ArtifactPreview({ head, rawUrl, draft }: { head: ArtifactContent; rawUrl: string; draft?: string }) {
  const { media, artifact } = head;
  // While the editor is dirty the preview follows the draft, so an edit can be
  // judged before it is saved.
  const source = draft ?? head.content;

  if (media.form === "html" || media.form === "svg") {
    return <iframe className="artifact-frame" title={artifact.name} sandbox="allow-scripts" srcDoc={source} />;
  }
  if (media.form === "image") {
    return (
      <div className="artifact-stage">
        <img className="artifact-image" src={rawUrl} alt={artifact.name} />
      </div>
    );
  }
  if (media.form === "pdf") {
    return <iframe className="artifact-frame" title={artifact.name} src={rawUrl} />;
  }
  if (media.form === "markdown") {
    return <Markdown text={source} />;
  }
  if (media.form === "model") {
    return <ModelViewer url={rawUrl} name={artifact.name} />;
  }
  if (media.form === "binary") {
    return (
      <div className="view-body">
        <div className="empty">
          <b>{artifact.name} is not something DEV can draw yet.</b>
          <br />
          Served as {media.type}.
          <br />
          Reveal it to open the file in its own application.
        </div>
      </div>
    );
  }
  return <pre className="output fill">{source}</pre>;
}

/**
 * A deliberately small Markdown renderer: headings, fenced code, lists, rules,
 * bold/italic/code spans and links. Worker reports use nothing else. Anything
 * it does not know stays visible as its own literal text rather than vanishing.
 */
function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className="artifact-doc">
      {blocks.map((block, i) => {
        if (block.type === "code") return <pre key={i} className="artifact-code">{block.text}</pre>;
        if (block.type === "rule") return <hr key={i} />;
        if (block.type === "list")
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{inline(item)}</li>
              ))}
            </ul>
          );
        if (block.type === "heading") {
          const Tag = `h${block.level}` as "h1";
          return <Tag key={i}>{inline(block.text)}</Tag>;
        }
        return <p key={i}>{inline(block.text)}</p>;
      })}
    </div>
  );
}

type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; text: string }
  | { type: "list"; items: string[] }
  | { type: "rule" };

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      // Step over the closing fence, or stop at the end of an unclosed one.
      i += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (/^ {0,3}(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i += 1;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s)/.test(lines[i] ?? "")) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

/** Inline spans. Links render as plain text with their target in the title: a
 * report is not a place to hand a worker a live outbound click. */
function inline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) out.push(<code key={key++}>{token.slice(1, -1)}</code>);
    else if (token.startsWith("**")) out.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("*")) out.push(<em key={key++}>{token.slice(1, -1)}</em>);
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      out.push(
        <span key={key++} className="artifact-link" title={link[2]}>
          {link[1]}
        </span>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
