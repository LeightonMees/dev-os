// How a flow step reads what earlier steps produced, and how a condition decides which way to go.
//
// Deliberately a tiny, explicit language rather than JavaScript. A flow is a thing the user draws
// and DEV then runs unattended against a real repository, so a step's test must be readable at a
// glance and incapable of doing anything but compare two values. There is no `eval` here and no
// path to one: the parser recognises a fixed set of operators and nothing else.

/** What one finished step left behind, as a condition can see it. */
export interface StepResult {
  nodeId: string;
  label: string;
  status: string;
  output: string;
  exitCode: number | null;
}

/** A reference is `<step>.<field>`, where `<step>` is a node id or its label. */
const FIELDS = ["output", "status", "exitCode"] as const;
type Field = (typeof FIELDS)[number];

/**
 * Operators a condition may use, longest first so that "does not contain" is matched before
 * "contains" and "is not empty" before "is empty".
 */
const OPERATORS = [
  "does not contain",
  "is not empty",
  "does not match",
  "not contains",
  "is empty",
  "contains",
  "matches",
  "!=",
  ">=",
  "<=",
  "==",
  "=",
  ">",
  "<",
] as const;
type Operator = (typeof OPERATORS)[number];

export class FlowExpressionError extends Error {}

function findStep(steps: StepResult[], name: string): StepResult | undefined {
  const wanted = name.trim().toLowerCase();
  return steps.find((s) => s.nodeId.toLowerCase() === wanted) ?? steps.find((s) => s.label.trim().toLowerCase() === wanted);
}

/**
 * Read `<step>.<field>`, or throw with a message naming what is actually available. The reference
 * may be written bare (`tests.output`) or wrapped (`{{tests.output}}`) — the wrapped form is what
 * templates use, and a condition that had to drop the braces would be a trap.
 */
function resolve(reference: string, steps: StepResult[]): string {
  const trimmed = reference.trim().replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "").trim();
  const dot = trimmed.lastIndexOf(".");
  const stepName = dot >= 0 ? trimmed.slice(0, dot) : trimmed;
  const field = (dot >= 0 ? trimmed.slice(dot + 1) : "output") as Field;
  if (!(FIELDS as readonly string[]).includes(field)) {
    throw new FlowExpressionError(`"${field}" is not something a step has. Use one of: ${FIELDS.join(", ")}.`);
  }
  const step = findStep(steps, stepName);
  if (!step) {
    const known = steps.map((s) => s.label || s.nodeId);
    throw new FlowExpressionError(known.length ? `No earlier step called "${stepName}". Steps that have run: ${known.join(", ")}.` : `"${stepName}" refers to a step, but nothing has run before this one.`);
  }
  if (field === "status") return step.status;
  if (field === "exitCode") return step.exitCode === null ? "" : String(step.exitCode);
  return step.output;
}

/**
 * Replace every `{{ step.field }}` in a command or prompt with what that step produced, so a step
 * can act on the one before it. An unknown reference is an error rather than an empty string: a
 * prompt silently missing the output it was meant to act on is worse than a run that stops.
 */
export function interpolate(template: string, steps: StepResult[]): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, reference: string) => resolve(reference, steps));
}

/** Everything a template refers to, for the editor to check a step before it is ever run. */
export function referencedSteps(template: string): string[] {
  const out: string[] = [];
  for (const match of template.matchAll(/\{\{([^}]+)\}\}/g)) {
    const reference = (match[1] ?? "").trim();
    const dot = reference.lastIndexOf(".");
    const name = (dot >= 0 ? reference.slice(0, dot) : reference).trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/s.exec(trimmed);
  return quoted ? (quoted[2] ?? "") : trimmed;
}

/**
 * Decide a condition. Returns which branch the run takes, and the reason, which is recorded on the
 * node run so the history says why the flow went the way it did rather than only which way.
 *
 * Supported forms, where <ref> is `step.output`, `step.status` or `step.exitCode`:
 *   <ref> contains "text"        <ref> does not contain "text"
 *   <ref> matches "regex"        <ref> does not match "regex"
 *   <ref> is empty               <ref> is not empty
 *   <ref> == value               <ref> != value
 *   <ref> > n    >= n    < n    <= n        (numeric; both sides must be numbers)
 * A bare <ref> on its own is true when the value is non-empty and not "false" or "0".
 */
export function evaluateCondition(expression: string, steps: StepResult[]): { value: boolean; because: string } {
  const text = expression.trim();
  if (!text) throw new FlowExpressionError("This condition has no test.");

  // Templates are allowed on the right-hand side too, so one step can be compared to another.
  const operator = OPERATORS.find((op) => indexOfOperator(text, op) > 0);
  if (!operator) {
    const value = resolve(text, steps);
    const truthy = value.trim() !== "" && value.trim().toLowerCase() !== "false" && value.trim() !== "0";
    return { value: truthy, because: `${text} is ${truthy ? "set" : "empty or false"}` };
  }

  const at = indexOfOperator(text, operator);
  const left = resolve(text.slice(0, at), steps);
  const rightRaw = text.slice(at + operator.length).trim();

  if (operator === "is empty" || operator === "is not empty") {
    const empty = left.trim() === "";
    const value = operator === "is empty" ? empty : !empty;
    return { value, because: `${text.slice(0, at).trim()} is ${empty ? "empty" : `${left.trim().length} characters`}` };
  }

  // A right-hand side may itself reference a step, so two outputs can be compared directly.
  const right = /^\{\{.*\}\}$/s.test(rightRaw) ? interpolate(rightRaw, steps) : unquote(rightRaw);
  const shown = (v: string) => (v.length > 60 ? `${v.slice(0, 57)}…` : v);

  switch (operator) {
    case "contains":
      return { value: left.includes(right), because: `output ${left.includes(right) ? "contains" : "does not contain"} "${shown(right)}"` };
    case "does not contain":
    case "not contains":
      return { value: !left.includes(right), because: `output ${left.includes(right) ? "contains" : "does not contain"} "${shown(right)}"` };
    case "matches":
    case "does not match": {
      let regex: RegExp;
      try {
        regex = new RegExp(right);
      } catch (error) {
        throw new FlowExpressionError(`"${right}" is not a valid pattern: ${(error as Error).message}`);
      }
      const hit = regex.test(left);
      return { value: operator === "matches" ? hit : !hit, because: `output ${hit ? "matches" : "does not match"} /${shown(right)}/` };
    }
    case "==":
    case "=":
      return { value: left.trim() === right, because: `"${shown(left.trim())}" ${left.trim() === right ? "equals" : "does not equal"} "${shown(right)}"` };
    case "!=":
      return { value: left.trim() !== right, because: `"${shown(left.trim())}" ${left.trim() !== right ? "does not equal" : "equals"} "${shown(right)}"` };
    default: {
      const a = Number(left.trim());
      const b = Number(right);
      if (Number.isNaN(a) || Number.isNaN(b)) {
        throw new FlowExpressionError(`"${operator}" compares numbers, but got "${shown(left.trim())}" and "${shown(right)}".`);
      }
      const value = operator === ">" ? a > b : operator === ">=" ? a >= b : operator === "<" ? a < b : a <= b;
      return { value, because: `${a} ${operator} ${b} is ${value}` };
    }
  }
}

/**
 * Where an operator starts, ignoring any inside a `{{ }}` reference or a quoted string, so a
 * command containing the word "contains" is not mistaken for an operator.
 */
function indexOfOperator(text: string, operator: Operator): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (text.startsWith("{{", i)) {
      depth++;
      i++;
      continue;
    }
    if (text.startsWith("}}", i)) {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    if (depth === 0 && text.startsWith(operator, i)) {
      // A word operator must stand alone: "contains" in "maintains" is not an operator.
      const before = text[i - 1] ?? " ";
      const after = text[i + operator.length] ?? " ";
      const wordy = /[a-z]/i.test(operator[0] ?? "");
      if (!wordy || (/[\s)]/.test(before) && /[\s"']/.test(after))) return i;
    }
  }
  return -1;
}
