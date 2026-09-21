import { useCallback, useEffect, useState } from "react";

import type { DevConfig, DoctorCheck, RoutingAdvice, WorkerModelsResponse } from "../lib/api.ts";
import { useStore } from "../lib/store.tsx";

interface Field {
  key: string;
  label: string;
  hint?: string;
  type?: "text" | "number" | "minutes" | "boolean" | "select" | "model" | "effort" | "worker" | "capability-preferences";
  /** For types "model" and "effort": the worker whose real list fills the dropdown. */
  worker?: string;
  options?: string[];
}

const GROUPS: { title: string; fields: Field[] }[] = [
  {
    title: "Workers",
    fields: [
      { key: "workers.preferences", label: "Preference order (fallback)", hint: 'Used when a kind of work has no list of its own. Leave it empty ([]) to let the benchmark evidence below decide, or state your own order as a JSON array, e.g. ["codex","claude-code","shell"]. A worker set on a task always wins over both.' },
      { key: "workers.preferencesByCapability", label: "Who is best at what", type: "capability-preferences", hint: "Workers are not equally good at everything. Set the order per kind of work and DEV routes by the task's kind: decisions and epics ask for planning, prep tasks ask for research, the rest ask for code." },
      { key: "workers.timeoutMs", label: "Shell timeout (minutes)", type: "minutes", hint: "Hung commands die after this. Default 30." },
      { key: "workers.agentTimeoutMs", label: "Agent timeout (minutes)", type: "minutes", hint: "Claude Code, Codex, Grok and the other agents. Default 120. A retry after a timeout doubles once, up to 4 hours." },
      { key: "workers.claudeCode.command", label: "Claude Code command" },
      { key: "workers.claudeCode.model", label: "Claude Code model", type: "model", worker: "claude-code", hint: "null = whatever the CLI defaults to" },
      { key: "workers.claudeCode.effort", label: "Claude Code reasoning effort", type: "effort", worker: "claude-code" },
      { key: "workers.claudeCode.permissionMode", label: "Claude Code permission mode", type: "select", options: ["bypassPermissions", "acceptEdits", "dontAsk", "auto", "plan", "manual"], hint: "acceptEdits lets a worker edit files but NOT run commands: a non-interactive run cannot get approval, so tests and builds are refused. bypassPermissions lets it run commands in the project directory, which is what verification needs." },
      { key: "workers.codex.command", label: "Codex command" },
      { key: "workers.codex.model", label: "Codex model", type: "model", worker: "codex", hint: "null = whatever the CLI defaults to" },
      { key: "workers.codex.effort", label: "Codex reasoning effort", type: "effort", worker: "codex" },
      { key: "workers.grok.command", label: "Grok command" },
      { key: "workers.grok.model", label: "Grok model", type: "model", worker: "grok", hint: "null = whatever the CLI defaults to" },
      { key: "workers.grok.effort", label: "Grok reasoning effort", type: "effort", worker: "grok" },
      { key: "workers.opencode.command", label: "OpenCode command" },
      { key: "workers.opencode.model", label: "OpenCode model", type: "model", worker: "opencode", hint: "null = whatever the CLI defaults to" },
      { key: "workers.opencode.effort", label: "OpenCode model variant", type: "effort", worker: "opencode" },
      { key: "workers.ollama.baseUrl", label: "Ollama URL" },
      { key: "workers.ollama.model", label: "Ollama model", type: "model", worker: "ollama", hint: "used for summaries and as a planning fallback" },
    ],
  },
  {
    title: "Context budget",
    fields: [
      { key: "context.budgetTokens", label: "Tokens per worker brief", type: "number", hint: "everything beyond this is cut, lowest priority first" },
      { key: "context.maxFileTokens", label: "Tokens per included file", type: "number" },
      { key: "context.maxFiles", label: "Max files per task", type: "number" },
    ],
  },
  {
    title: "Planning & approvals",
    fields: [
      { key: "planning.maxTasks", label: "Max tasks per plan", type: "number" },
      { key: "planning.worker", label: "Planning worker", type: "worker", hint: "null = first healthy planner in preference order" },
      { key: "approvals.requireForCommit", label: "Require approval for commits", type: "boolean" },
    ],
  },
  {
    title: "Nexus",
    fields: [
      { key: "nexus.enabled", label: "Enabled", type: "boolean" },
      { key: "nexus.command", label: "Command" },
      { key: "nexus.args", label: "Arguments", hint: "JSON array" },
      { key: "nexus.timeoutMs", label: "Timeout (ms)", type: "number" },
    ],
  },
  {
    title: "Terminal & storage",
    fields: [
      { key: "terminal.shell", label: "Shell", hint: "null = pwsh, then powershell" },
      { key: "storage.keepLogs", label: "Keep execution logs", type: "boolean" },
      { key: "controlPlane.port", label: "Control plane port", type: "number", hint: "restart the control plane after changing" },
    ],
  },
];

function get(config: DevConfig, key: string): unknown {
  return key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), config);
}

export function SettingsView() {
  const { api, toast, home, status } = useStore();
  const [config, setConfig] = useState<DevConfig | null>(null);
  const [keys, setKeys] = useState<{ provider: string; env: string; set: boolean }[]>([]);
  const [secretFiles, setSecretFiles] = useState<string[]>([]);
  const [checks, setChecks] = useState<DoctorCheck[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const load = () =>
    api
      .config()
      .then((c) => {
        setConfig(c.config);
        setKeys(c.keys ?? []);
        setSecretFiles(c.secrets?.files ?? []);
      })
      .catch((e: Error) => toast("error", e.message));
  useEffect(() => {
    void load();
    const onDoctor = () => void runDoctor();
    window.addEventListener("dev:run-doctor", onDoctor);
    return () => window.removeEventListener("dev:run-doctor", onDoctor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);
  /** A provider's model lives in an array entry, which the dotted-key setter cannot address. */
  const saveProviderModel = async (id: string, model: string) => {
    try {
      const result = await api.setProviderModel(id, model);
      toast("success", `${id} model set to ${result.model} · ${result.note}`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  /** Take a key here rather than sending the user to a terminal. The value is written and forgotten. */
  const addKey = async (env: string) => {
    const value = window.prompt(`Paste the value for ${env}. It is written to your secrets file and never shown again.`);
    if (!value?.trim()) return;
    try {
      const saved = await api.setSecret(env, value.trim());
      toast("success", `${saved.name} ${saved.replaced ? "replaced in" : "written to"} ${saved.file} · restart the control plane to use it`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const setProviderEnabled = async (id: string, enabled: boolean) => {
    try {
      const result = await api.setProviderEnabled(id, enabled);
      toast("success", `${id} ${result.enabled ? "enabled" : "disabled"} · ${result.note}`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };

  const save = async (key: string, value: string) => {
    try {
      const result = await api.setConfig(key, value);
      setConfig(result.config);
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      toast("success", `${key} saved · ${result.note}`);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  };
  const runDoctor = async () => {
    setBusy(true);
    try {
      setChecks(await api.doctor());
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="view">
      <div className="toolbar">
        <h1>Settings</h1>
        <span className="sub selectable">{home ? `${home}\\config.json` : ""}</span>
        <span className="spacer" />
        <button className="btn small" onClick={runDoctor} disabled={busy}>
          {busy ? "Checking…" : "Run doctor"}
        </button>
      </div>
      <div className="view-body">
        {checks && (
          <div className="section">
            <div className="label">
              Doctor <span className="count">{checks.filter((c) => c.status === "ok").length}/{checks.length} ok</span>
            </div>
            {checks.map((c) => (
              <div key={c.name} className="check-row">
                <span className={c.status === "ok" ? "ok" : c.status === "warning" ? "warn" : "err"}>{c.status === "ok" ? "✓" : c.status === "warning" ? "!" : "✗"}</span>
                <span className="mono">{c.name}</span>
                <span className="selectable">{c.detail}</span>
                {c.remediation && c.status !== "ok" && <span className="rem">→ {c.remediation}</span>}
              </div>
            ))}
          </div>
        )}
        {keys.length > 0 && (
          <div className="section" id="settings-api-keys">
            <div className="label">API keys</div>
            <table className="table rows">
              <tbody>
                {keys.map((k) => {
                  const provider = config?.workers.api.providers.find((p) => p.id === k.provider);
                  return (
                    <tr key={k.provider}>
                      <td style={{ width: 20 }} className={k.set ? "ok" : "dim"}>{k.set ? "●" : "○"}</td>
                      <td style={{ width: 160 }}>{k.provider}</td>
                      <td className="mono dim">{k.env || "no key needed"}</td>
                      <td style={{ width: 90 }} className={k.set ? "ok" : "dim"}>{k.set ? "set" : "missing"}</td>
                      <td style={{ width: 300 }}>
                        {provider && <ProviderModelField provider={provider} disabled={!k.set} onSave={(model) => saveProviderModel(k.provider, model)} />}
                      </td>
                      <td style={{ width: 110 }}>
                        {provider && (
                          <label className="row small" style={{ gap: 5 }} title={provider.enabled ? "Turn this provider off" : "Turn this provider on"}>
                            <input type="checkbox" checked={provider.enabled !== false} onChange={(e) => setProviderEnabled(k.provider, e.target.checked)} />
                            enabled
                          </label>
                        )}
                      </td>
                      <td style={{ width: 120 }}>
                        {k.env && (
                          <button className="btn small" onClick={() => addKey(k.env)}>
                            {k.set ? "Replace key" : "Add key"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="dim small" style={{ marginTop: 4 }}>
              Read at startup from {secretFiles.join(" and ") || "no secret file found"}. Keys added here are written to that file and never shown again; the control plane must restart before a new key is used (<code className="cmd">dev control-plane stop</code>).
            </div>
          </div>
        )}
        {!config && <div className="muted">Loading…</div>}
        {config &&
          GROUPS.map((g) => (
            <div className="section" key={g.title} id={`settings-${g.title.replace(/\W+/g, "-").toLowerCase()}`}>
              <div className="label">{g.title}</div>
              <table className="table">
                <tbody>
                  {g.fields.map((f) => {
                    const current = get(config, f.key);
                    const draft = drafts[f.key];
                    const display = draft ?? (current === null ? "null" : typeof current === "object" ? JSON.stringify(current) : String(current));
                    return (
                      <tr key={f.key}>
                        <td style={{ width: 260 }}>
                          <div>{f.label}</div>
                          <div className="mono dim small">{f.key}</div>
                        </td>
                        <td>
                          {f.type === "boolean" ? (
                            <input type="checkbox" checked={current === true} onChange={(e) => save(f.key, String(e.target.checked))} />
                          ) : f.type === "select" ? (
                            <select className="select" style={{ width: "auto" }} value={String(current)} onChange={(e) => save(f.key, e.target.value)}>
                              {f.options?.map((o) => (
                                <option key={o} value={o}>
                                  {o}
                                </option>
                              ))}
                            </select>
                          ) : f.type === "worker" ? (
                            <select className="select" style={{ width: "auto" }} value={current === null ? "null" : String(current)} onChange={(e) => save(f.key, e.target.value)}>
                              <option value="null">null (DEV routes it)</option>
                              {(status?.workers ?? []).map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                  {w.health && !w.health.ok ? " (down)" : ""}
                                </option>
                              ))}
                            </select>
                          ) : f.type === "capability-preferences" ? (
                            <>
                              <CapabilityPreferences value={(current ?? {}) as Record<string, string[]>} workers={status?.workers ?? []} onSave={(v) => save(f.key, JSON.stringify(v))} />
                              <BenchmarkAdvice onApply={(v) => save(f.key, JSON.stringify(v))} />
                            </>
                          ) : f.type === "model" ? (
                            <WorkerModelField worker={f.worker as string} value={current === null ? "" : String(current)} onSave={(v) => save(f.key, v)} />
                          ) : f.type === "effort" ? (
                            <WorkerEffortField worker={f.worker as string} value={current === null ? "" : String(current)} onSave={(v) => save(f.key, v)} />
                          ) : f.type === "minutes" ? (
                            <div className="row">
                              <input
                                className="input mono"
                                style={{ maxWidth: 120 }}
                                value={draft ?? String(Math.round(Number(current) / 60_000) || 0)}
                                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key !== "Enter" || draft === undefined) return;
                                  const minutes = Number(draft);
                                  if (!Number.isFinite(minutes) || minutes < 0) return;
                                  void save(f.key, String(Math.round(minutes * 60_000)));
                                }}
                              />
                              {draft !== undefined && (
                                <button
                                  className="btn small primary"
                                  onClick={() => {
                                    const minutes = Number(draft);
                                    if (!Number.isFinite(minutes) || minutes < 0) return;
                                    void save(f.key, String(Math.round(minutes * 60_000)));
                                  }}
                                >
                                  Save
                                </button>
                              )}
                            </div>
                          ) : (
                            <div className="row">
                              <input
                                className="input mono"
                                style={{ maxWidth: 520 }}
                                value={display}
                                onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                                onKeyDown={(e) => e.key === "Enter" && draft !== undefined && save(f.key, draft)}
                              />
                              {draft !== undefined && (
                                <button className="btn small primary" onClick={() => save(f.key, draft)}>
                                  Save
                                </button>
                              )}
                            </div>
                          )}
                          {f.hint && <div className="dim small">{f.hint}</div>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        <div className="dim small">
          Values are stored in config.json. Text fields accept null, true/false, numbers and JSON arrays. Worker and Nexus changes apply after the control plane restarts (dev control-plane stop; it restarts on the next launch).
        </div>
      </div>
    </div>
  );
}

/**
 * The models a worker can be given, asked of the worker itself: Codex's model cache, `grok models`,
 * `opencode models`, what Ollama has pulled, a provider's /models. The source is shown, so a
 * documented list is never mistaken for a discovered one. A free-form id stays possible where the
 * tool accepts one.
 */
function WorkerModelField({ worker, value, onSave }: { worker: string; value: string; onSave: (value: string) => void }) {
  const { api, toast } = useStore();
  const [state, setState] = useState<{ models: { id: string; label: string; note?: string }[]; source: string; detail: string | null; free: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setState(null);
    api
      .workerModels(worker)
      .then(setState)
      .catch((e: Error) => setState({ models: [], source: "unavailable", detail: e.message, free: true }));
  }, [api, worker]);
  useEffect(load, [load]);

  const pull = async () => {
    const model = window.prompt("Pull which Ollama model? Examples: qwen2.5-coder:7b, llama3.2:3b, nomic-embed-text", value || "qwen2.5-coder:7b");
    if (!model?.trim()) return;
    setBusy(true);
    try {
      await api.ollamaPull(model.trim());
      toast("success", `Pulled ${model.trim()}`);
      load();
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const custom = () => {
    const next = window.prompt(`Model id for ${worker} (anything the tool accepts)`, value);
    if (next !== null) onSave(next.trim() || "null");
  };

  if (!state) return <span className="dim">Reading the model list…</span>;
  const known = state.models.some((m) => m.id === value);
  return (
    <div>
      <div className="row">
        <select
          className="select"
          style={{ width: "auto", maxWidth: 360 }}
          value={known ? value : value ? "__current" : ""}
          aria-label="Model"
          onChange={(e) => {
            if (e.target.value === "__custom") custom();
            else if (e.target.value !== "__current") onSave(e.target.value || "null");
          }}
        >
          <option value="">null (the tool's own default)</option>
          {!known && value && <option value="__current">{value} (not in the list)</option>}
          {state.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.note ? ` · ${m.note}` : ""}
            </option>
          ))}
          {state.free && <option value="__custom">Custom…</option>}
        </select>
        {worker === "ollama" && (
          <button className="btn small" disabled={busy} onClick={pull} title="Download another model into Ollama">
            {busy ? "Pulling…" : "Pull a model…"}
          </button>
        )}
        <button className="btn ghost small" onClick={load} title="Ask the tool again">
          Refresh
        </button>
      </div>
      <div className="dim small">
        {state.models.length} from {state.source}
        {state.detail ? ` — ${state.detail}` : ""}
      </div>
    </div>
  );
}

/**
 * How hard this worker's model is told to think — the second dial, separate from which model runs.
 * "opus" is the model; "low" is the effort.
 *
 * The levels come from the worker itself: Claude Code publishes its ladder in `claude --help`, and
 * a CLI that takes any string says so and offers a Custom entry. A worker with no such dial renders
 * nothing rather than an inert control, so the UI never implies a setting that does nothing.
 */
function WorkerEffortField({ worker, value, onSave }: { worker: string; value: string; onSave: (value: string) => void }) {
  const { api } = useStore();
  const [state, setState] = useState<WorkerModelsResponse["efforts"] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .workerModels(worker)
      .then((r) => live && setState(r.efforts))
      .catch((e: Error) => live && setFailed(e.message));
    return () => {
      live = false;
    };
  }, [api, worker]);

  if (failed) return <span className="dim small">could not read the effort levels — {failed}</span>;
  if (!state) return <span className="dim">Reading the effort levels…</span>;
  if (state.levels.length === 0) return <span className="dim small">{state.source}</span>;

  const known = state.levels.includes(value);
  const custom = () => {
    const next = window.prompt(`Reasoning effort for ${worker} (${state.source})`, value);
    if (next !== null) onSave(next.trim() || "null");
  };
  return (
    <div>
      <div className="row">
        <select
          className="select"
          style={{ width: "auto", maxWidth: 240 }}
          aria-label="Reasoning effort"
          value={known ? value : value ? "__current" : ""}
          onChange={(e) => {
            if (e.target.value === "__custom") custom();
            else if (e.target.value !== "__current") onSave(e.target.value || "null");
          }}
        >
          <option value="">null (decided per task)</option>
          {!known && value && <option value="__current">{value} (not in the list)</option>}
          {state.levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
          {state.free && <option value="__custom">Custom…</option>}
        </select>
      </div>
      <div className="dim small">
        passed as {state.flag} · {state.source}
      </div>
    </div>
  );
}

/** One API provider's model, offered from that provider's own /models endpoint. */
function ProviderModelField({ provider, disabled, onSave }: { provider: { id: string; name: string; model: string }; disabled: boolean; onSave: (model: string) => void }) {
  const { api } = useStore();
  const [models, setModels] = useState<{ id: string }[] | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const load = useCallback(() => {
    api
      .workerModels(provider.id)
      .then((r) => {
        setModels(r.models);
        setDetail(r.detail);
      })
      .catch((e: Error) => setDetail(e.message));
  }, [api, provider.id]);

  if (disabled) return <span className="dim small">add a key to list models</span>;
  if (models === null)
    return (
      <div className="row">
        <span className="mono small ellipsis" title={provider.model}>
          {provider.model}
        </span>
        <button className="btn ghost small" onClick={load} title={`Ask ${provider.name} which models it offers`}>
          List models
        </button>
        {detail && <span className="warn small">{detail}</span>}
      </div>
    );
  const known = models.some((m) => m.id === provider.model);
  return (
    <div className="row">
      <select className="select" style={{ width: "auto", maxWidth: 260 }} value={known ? provider.model : "__current"} aria-label={`${provider.name} model`} onChange={(e) => e.target.value !== "__current" && onSave(e.target.value)}>
        {!known && <option value="__current">{provider.model} (not listed)</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id}
          </option>
        ))}
      </select>
      <span className="dim small">{models.length}</span>
    </div>
  );
}

/**
 * Which worker to try first for each kind of work. DEV ships with no opinion here: the ordering is
 * the user's judgement about their own tools, and an empty list just means "use the fallback order".
 */
function CapabilityPreferences({ value, workers, onSave }: { value: Record<string, string[]>; workers: { id: string; name: string; capabilities: string[]; health: { ok: boolean } | null }[]; onSave: (value: Record<string, string[]>) => void }) {
  const CAPABILITIES: { id: string; label: string; what: string }[] = [
    { id: "code", label: "Code", what: "writing and changing code (ticket and subtask work)" },
    { id: "plan", label: "Plan", what: "decisions and epics: shaping the work before it is written" },
    { id: "research", label: "Research", what: "prep tasks: reading around a problem and reporting back" },
    { id: "review", label: "Review", what: "judging work that already exists" },
    { id: "summarize", label: "Summarise", what: "condensing output and history" },
  ];
  const set = (capability: string, order: string[]) => {
    const next = { ...value };
    if (order.length === 0) delete next[capability];
    else next[capability] = order;
    onSave(next);
  };
  return (
    <div>
      {CAPABILITIES.map((c) => {
        const able = workers.filter((w) => w.capabilities.includes(c.id));
        const order = value[c.id] ?? [];
        const rest = able.filter((w) => !order.includes(w.id));
        return (
          <div key={c.id} className="row" style={{ gap: 6, marginBottom: 4, flexWrap: "wrap", alignItems: "baseline" }}>
            <span style={{ width: 84 }} title={c.what}>
              {c.label}
            </span>
            {order.map((id, i) => (
              <span key={id} className="pref-chip">
                {i + 1}. {id}
                <button className="x" aria-label={`Remove ${id} from ${c.label}`} onClick={() => set(c.id, order.filter((x) => x !== id))}>
                  ✕
                </button>
              </span>
            ))}
            {rest.length > 0 && (
              <select
                className="select"
                style={{ width: "auto" }}
                value=""
                aria-label={`Add a worker for ${c.label}`}
                onChange={(e) => e.target.value && set(c.id, [...order, e.target.value])}
              >
                <option value="">{order.length ? "then…" : "first choice…"}</option>
                {rest.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {w.health && !w.health.ok ? " (down)" : ""}
                  </option>
                ))}
              </select>
            )}
            {order.length === 0 && <span className="dim small">falls back to the general order</span>}
          </div>
        );
      })}
    </div>
  );
}

/**
 * What public benchmarks say, with the source and the date each was read. DEV shows the evidence
 * and lets the user apply it; it never rewrites their routing on its own, and it says plainly that
 * a benchmark measures the model rather than the tool around it.
 */
function BenchmarkAdvice({ onApply }: { onApply: (value: Record<string, string[]>) => void }) {
  const { api, toast } = useStore();
  const [advice, setAdvice] = useState<RoutingAdvice | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => {
    setOpen(true);
    api
      .routingSuggestion()
      .then(setAdvice)
      .catch((e: Error) => toast("error", e.message));
  };
  if (!open)
    return (
      <button className="btn ghost small" style={{ marginTop: 6 }} onClick={load}>
        What do the benchmarks say?
      </button>
    );
  if (!advice) return <div className="dim small" style={{ marginTop: 6 }}>Reading the benchmark table…</div>;
  const proposed = Object.fromEntries(advice.suggestions.filter((s) => s.order.length > 0).map((s) => [s.capability, s.order]));
  return (
    <div className="section" style={{ marginTop: 8 }}>
      <div className="label">
        Benchmarks · read {advice.capturedOn} · {advice.inUse ? "in force (no preference order set)" : "advisory (your preference order wins)"}
      </div>
      <table className="table rows">
        <tbody>
          {advice.suggestions.map((s) => (
            <tr key={s.capability}>
              <td style={{ width: 84 }}>{s.capability}</td>
              <td style={{ width: 190 }} className="mono">
                {s.order.length ? s.order.join(" → ") : <span className="dim">nothing here matches</span>}
              </td>
              <td className="small">
                {s.because}
                {s.confidence === "weak" && <span className="warn"> · weak basis</span>}
                {s.evidence.map((e) => (
                  <span key={e.benchmark} className="dim">
                    {" · "}
                    <a href={e.source} target="_blank" rel="noreferrer" title={`${e.what}${e.caveat ? ` — ${e.caveat}` : ""}`}>
                      {e.benchmark}
                    </a>
                    {/* A discounted benchmark is never shown as if it counted in full. */}
                    {e.weight < 1 && <span title={e.caveat}> (×{e.weight})</span>}
                  </span>
                ))}
                {s.unavailable.length > 0 && <span className="dim"> · not available here: {s.unavailable.join(", ")}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim small" style={{ margin: "6px 0" }}>{advice.note}</div>
      <div className="row">
        <button className="btn small" onClick={() => onApply(proposed)} title="Replace your per-capability order with what the benchmarks support">
          Apply this order
        </button>
        <button className="btn ghost small" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );
}
