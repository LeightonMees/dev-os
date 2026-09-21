import { useStore } from "../lib/store.tsx";

export function OfflineView() {
  const { api, connectionError, refresh } = useStore();
  return (
    <div className="view">
      <div className="toolbar">
        <h1>Control plane unreachable</h1>
      </div>
      <div className="view-body">
        <div className="empty" style={{ maxWidth: 560 }}>
          <b>DEV could not reach its control plane at {api.baseUrl}.</b>
          <br />
          {connectionError && <span className="err">{connectionError}</span>}
          <p>The app tries to start it when it opens (that needs Node 24+ on your PATH and this repository next to the app). If it keeps failing, start it by hand in a terminal to see the real error:</p>
          <code>dev control-plane start --foreground</code>
          <p>
            <button className="btn primary" onClick={() => refresh()}>
              Retry now
            </button>{" "}
            <span className="dim">retrying every 5 seconds</span>
          </p>
        </div>
      </div>
    </div>
  );
}
