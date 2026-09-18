import { SECTIONS, useStore } from "../lib/store.tsx";
import { Icon } from "./Icon.tsx";

export function ActivityBar() {
  const { section, setSection, currentProject, status, setPalette, toggleSidebar, sidebarOpen, attention } = useStore();
  const counts = currentProject?.tasks;
  const running = status?.running.length ?? 0;
  const badge = (id: string) => {
    if (id === "work" && counts) {
      if (attention.length > 0) return <span className="count warn" title={`${attention.length} request(s) waiting for you`}>{attention.length}</span>;
      if (counts.BLOCKED > 0) return <span className="count err">{counts.BLOCKED}</span>;
      if (counts.REVIEW > 0) return <span className="count warn">{counts.REVIEW}</span>;
      if (counts.WORKING > 0) return <span className="count live">{counts.WORKING}</span>;
      return null;
    }
    if (id === "workers" && running > 0) return <span className="count live">{running}</span>;
    return null;
  };
  return (
    <nav className="activitybar" aria-label="Sections">
      <div className="brand" title="DEV">
        DEV
      </div>
      {SECTIONS.map((s) => (
        <button key={s.id} className={`activity${section === s.id ? " active" : ""}`} onClick={() => setSection(s.id)} title={`${s.label}  Ctrl+${s.key}`} aria-label={s.label} aria-current={section === s.id ? "page" : undefined}>
          <Icon name={s.icon} />
          {badge(s.id)}
        </button>
      ))}
      <div className="activity-spacer" />
      <button className="activity" onClick={() => setPalette(true)} title="Command palette  Ctrl+K" aria-label="Command palette">
        <Icon name="search" />
      </button>
      <button className={`activity${sidebarOpen ? "" : " active"}`} onClick={toggleSidebar} title="Toggle sidebar  Ctrl+B" aria-label="Toggle sidebar">
        <Icon name="side" />
      </button>
    </nav>
  );
}
