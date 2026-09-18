import type { ReactNode } from "react";

import { define } from "../lib/glossary.ts";

/** A word with a one-sentence definition on hover, for concepts a learner meets for the first time. */
export function Term({ word, children }: { word: string; children?: ReactNode }) {
  const def = define(word);
  if (!def) return <>{children ?? word}</>;
  return (
    <span className="term" data-def={def} tabIndex={0} aria-label={`${word}: ${def}`}>
      {children ?? word}
    </span>
  );
}
