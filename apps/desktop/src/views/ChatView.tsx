import { useEffect, useRef, useState } from "react";

import { Icon } from "../components/Icon.tsx";
import { Term } from "../components/Term.tsx";
import type { Conversation, StoredMessage } from "../lib/api.ts";
import { ago, truncate } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

/**
 * Talk to DEV. The brain (an API model or Ollama) answers with DEV's own tools:
 * it creates projects and tasks and launches runs; every call is shown as it was
 * made, so nothing is hidden behind "AI magic".
 */
export function ChatView() {
  const { api, act, toast, currentProject, projects, conversationId, selectConversation, feed, setSection, selectProject, refresh } = useStore();
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [brain, setBrain] = useState<{ id: string; model: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const chatEvents = feed.filter((e) => e.type === "CHAT_MESSAGE" && e.data.conversationId === conversationId).length;

  const load = async (id: string) => {
    try {
      const result = await api.conversation(id);
      setConversation(result.conversation);
      setMessages(result.messages);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      selectConversation(null);
    }
  };
  useEffect(() => {
    if (conversationId) void load(conversationId);
    else {
      setConversation(null);
      setMessages([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, chatEvents]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages.length, busy]);

  const ensureConversation = async (): Promise<string> => {
    if (conversationId && conversation) return conversationId;
    const created = await api.createConversation(currentProject?.id ?? null);
    selectConversation(created.id);
    setConversation(created);
    return created.id;
  };
  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setDraft("");
    setError(null);
    const optimistic: StoredMessage = { id: -1, conversationId: conversationId ?? "", role: "user", content: text, toolCalls: null, toolCallId: null, name: null, meta: {}, createdAt: new Date().toISOString() };
    setMessages((m) => [...m, optimistic]);
    try {
      const id = await ensureConversation();
      const turn = await api.sendChat(id, text);
      setBrain(turn.brain);
      setConversation(turn.conversation);
      await load(id);
      await refresh();
      if (turn.conversation.projectId && turn.conversation.projectId !== currentProject?.id) selectProject(turn.conversation.projectId);
    } catch (e) {
      setError((e as Error).message);
      toast("error", (e as Error).message);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };
  const cancel = () => {
    if (conversationId) void api.cancelChat(conversationId).catch(() => undefined);
  };

  return (
    <div className="view">
      <div className="toolbar">
        <h1>Chat</h1>
        <span className="sub">{conversation ? truncate(conversation.title, 60) : "new conversation"}</span>
        {conversation && (
          <select
            className="select auto"
            value={conversation.projectId ?? ""}
            aria-label="Conversation project"
            onChange={(e) =>
              act(() => api.setConversationProject(conversation.id, e.target.value || null)).then(() => {
                if (conversationId) void load(conversationId);
              })
            }
          >
            <option value="">no project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {brain && (
          <span className="sub" title="the model answering as DEV">
            {brain.id} {brain.model}
          </span>
        )}
        <button className="btn small" onClick={() => selectConversation(null)}>
          <Icon name="plus" size={11} /> New conversation
        </button>
      </div>
      <div className="chat-scroll" ref={scroller}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <b>Tell DEV what you want to build.</b>
            <p>
              DEV plans in small slices, creates the project and the tasks, and hands the coding to a <Term word="worker">worker</Term>. You watch it happen in Work and Output. Every tool call DEV makes is shown here.
            </p>
            <p className="dim">
              Try: “Make me a small Node CLI that converts CSV to JSON, with tests.” or “What is blocked in {currentProject?.name ?? "my project"} and what should I do next?”
            </p>
          </div>
        )}
        {messages.map((m) => (
          <Message key={m.id === -1 ? "pending" : m.id} m={m} onOpenTask={(id) => (setSection("work"), window.setTimeout(() => window.dispatchEvent(new CustomEvent("dev:select-task", { detail: id })), 0))} />
        ))}
        {busy && (
          <div className="chat-row assistant">
            <div className="chat-who">DEV</div>
            <div className="chat-bubble dim">
              working <span className="sym WORKING">▶</span>
              <button className="btn ghost small" style={{ marginLeft: 8 }} onClick={cancel}>
                Stop
              </button>
            </div>
          </div>
        )}
        {error && <div className="failure">{error}</div>}
      </div>
      <div className="chat-composer">
        <textarea
          ref={input}
          className="textarea"
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={currentProject ? `Ask DEV about ${currentProject.name}, or describe what to build next…` : "Describe the app you want. DEV creates the project, plans the first milestone and starts the work."}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          aria-label="Message to DEV"
        />
        <div className="row" style={{ justifyContent: "space-between" }}>
          <span className="dim small">Enter sends, Shift+Enter for a new line. DEV only acts through its tools; results appear in Work.</span>
          <button className="btn primary" onClick={send} disabled={busy || !draft.trim()}>
            <Icon name="send" size={12} /> Send
          </button>
        </div>
      </div>
    </div>
  );
}

function Message({ m, onOpenTask }: { m: StoredMessage; onOpenTask: (id: string) => void }) {
  if (m.role === "tool") {
    return (
      <div className="chat-row tool">
        <div className="chat-who">{m.name}</div>
        <pre className="chat-tool-out">{truncate(m.content ?? "", 600)}</pre>
      </div>
    );
  }
  if (m.role === "assistant" && !m.content && m.toolCalls?.length) {
    return (
      <div className="chat-row assistant">
        <div className="chat-who">DEV</div>
        <div className="chat-calls">
          {m.toolCalls.map((c) => (
            <span key={c.id} className="chat-call" title={c.function.arguments}>
              → {c.function.name} <span className="dim">{truncate(c.function.arguments, 70)}</span>
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (m.role === "assistant" && !m.content) return null;
  const text = m.content ?? "";
  const ids = Array.from(new Set(text.match(/tsk_[a-z0-9]{10}/g) ?? []));
  return (
    <div className={`chat-row ${m.role}`}>
      <div className="chat-who">{m.role === "user" ? "You" : "DEV"}</div>
      <div className="chat-bubble selectable">
        {text}
        {ids.length > 0 && (
          <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
            {ids.map((id) => (
              <button key={id} className="btn small" onClick={() => onOpenTask(id)}>
                open {id}
              </button>
            ))}
          </div>
        )}
        <div className="dim small" style={{ marginTop: 4 }}>
          {ago(m.createdAt)}
          {typeof m.meta.model === "string" ? ` · ${m.meta.model}` : ""}
        </div>
      </div>
    </div>
  );
}
