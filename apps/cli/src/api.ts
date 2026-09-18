import type { DevEvent } from "@dev/core";

/** Thin client for the control plane. Used when it is running so the desktop sees the same live run. */
export class ControlPlaneClient {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not json
    }
    if (!response.ok) {
      const message = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : text;
      throw new Error(message || `${response.status} from control plane`);
    }
    return parsed as T;
  }

  /** Follow the SSE stream until `until` returns true or the signal aborts. */
  async stream(query: Record<string, string>, onEvent: (event: DevEvent) => void, until: (event: DevEvent) => boolean, signal?: AbortSignal): Promise<void> {
    const params = new URLSearchParams(query);
    const response = await fetch(`${this.url}/api/events/stream?${params}`, { signal });
    if (!response.ok || !response.body) throw new Error(`Event stream failed: ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const event = JSON.parse(dataLine.slice(6)) as DevEvent;
          onEvent(event);
          if (until(event)) return;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // stream already closed
      }
    }
  }
}
