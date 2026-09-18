import { useEffect, useRef, useState } from "react";

import type { ArtifactContent } from "../lib/api.ts";

/**
 * The code side of the artifact zone. Saving never overwrites the worker's
 * file: it writes the next version and hands it back, so the caller can follow
 * the chain forward.
 */
export function ArtifactEditor({
  head,
  draft,
  onDraft,
  onSave,
  saving,
}: {
  head: ArtifactContent;
  draft: string;
  onDraft: (value: string) => void;
  onSave: () => void;
  saving: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const dirty = draft !== head.content;
  const reason = !head.media.text
    ? `${head.artifact.name} is binary; edit it in the tool that made it.`
    : head.truncated
      ? "Only the tail of this file was loaded, so saving would drop the rest. Reveal it to edit in full."
      : null;

  const keydown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty && !reason && !saving) onSave();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      onDraft(`${draft.slice(0, start)}  ${draft.slice(end)}`);
      requestAnimationFrame(() => el.setSelectionRange(start + 2, start + 2));
    }
  };

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
  }, [head.artifact.id]);

  return (
    <div className="artifact-editor">
      <div className="panel-strip">
        <span className="mono small">{head.language ?? "text"}</span>
        <span className="dim small">{dirty ? "edited" : "saved"}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <button className="btn small primary" disabled={!dirty || saving || reason !== null} onClick={onSave} title={reason ?? "Save as the next version (Ctrl+S)"}>
          {saving ? "Saving…" : "Save version"}
        </button>
      </div>
      {reason && <div className="artifact-note">{reason}</div>}
      <textarea
        ref={ref}
        className="artifact-code-pane"
        spellCheck={false}
        value={draft}
        readOnly={reason !== null}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={keydown}
        aria-label={`${head.artifact.name} source`}
      />
    </div>
  );
}

/** Per-artifact draft state that resets when a different artifact is opened. */
export function useDraft(head: ArtifactContent | null) {
  const [draft, setDraft] = useState("");
  const id = head?.artifact.id ?? null;
  useEffect(() => {
    setDraft(head?.content ?? "");
  }, [id, head?.content]);
  return [draft, setDraft] as const;
}
