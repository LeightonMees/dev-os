// Bridge to the Tauri side. Every function degrades gracefully in a plain browser
// (vite dev without Tauri, or tests) so the UI stays testable.

export function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core");
  return mod.invoke<T>(command, args);
}

export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  const mod = await import("@tauri-apps/api/event");
  const off = await mod.listen<T>(event, (e) => handler(e.payload));
  return off;
}

export interface ControlPlaneInfo {
  url: string | null;
  home: string | null;
  started: boolean;
  error: string | null;
}

/** Ask the native side to start the control plane if needed. Outside Tauri, use the default URL. */
export async function ensureControlPlane(): Promise<ControlPlaneInfo> {
  if (!inTauri()) return { url: null, home: null, started: false, error: null };
  // A reload of the web view must not leave shells from the previous page alive.
  await invoke("pty_kill_all").catch(() => undefined);
  try {
    const info = await invoke<{ url: string; home: string; started: boolean }>("control_plane_ensure");
    return { ...info, error: null };
  } catch (error) {
    return { url: null, home: null, started: false, error: String(error) };
  }
}

export async function openInFileManager(path: string): Promise<void> {
  if (!inTauri()) return;
  await invoke("open_in_file_manager", { path });
}
