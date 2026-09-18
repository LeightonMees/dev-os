/**
 * OS-level notification when the window is not in front, through the web
 * Notification API (WebView2 supports it). Falls back silently; the in-app
 * toast always shows regardless.
 */
export async function notify(title: string, body: string): Promise<void> {
  try {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission !== "granted") return;
    if (document.visibilityState === "visible" && document.hasFocus()) return;
    new Notification(title, { body, tag: `dev-${title}`, silent: false });
  } catch {
    // notifications unavailable in this environment
  }
}
