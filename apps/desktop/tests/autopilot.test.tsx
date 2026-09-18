import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AutopilotDialog } from "../src/views/WorkView.tsx";

/**
 * Autopilot runs unattended, so it is gated behind an acknowledgement. The gate
 * is fine; a gate that looks like a broken button is not.
 */
describe("Autopilot dialog", () => {
  const open = (onStart = vi.fn()) => {
    render(<AutopilotDialog project="demo" runnable={0} backlog={12} needsHuman={0} onCancel={() => {}} onStart={onStart} />);
    return { start: screen.getByRole("button", { name: /start autopilot/i }) as HTMLButtonElement, onStart };
  };

  it("says why it cannot start yet, instead of presenting a dead button", () => {
    const { start } = open();
    expect(start.disabled).toBe(true);
    expect(start.title).toMatch(/tick the box/i);
    expect(screen.getByText(/required before autopilot can start/i)).toBeTruthy();
  });

  it("starts once the acknowledgement is given, and passes the chosen limit", () => {
    const { start, onStart } = open();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(5);
  });

  it("offers an unlimited run as undefined rather than a number", () => {
    const onStart = vi.fn();
    const { start } = open(onStart);
    fireEvent.change(screen.getByLabelText(/task limit/i), { target: { value: "unlimited" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(undefined);
  });

  it("shows how much backlog it may promote, so the blast radius is visible", () => {
    open();
    expect(screen.getByText("12")).toBeTruthy();
  });
});
