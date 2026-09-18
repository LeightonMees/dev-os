import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "../src/components/Dialog.tsx";

/** Every desktop dialog (task, plan, project) is built on this shell; its close paths must all work. */
describe("Dialog", () => {
  it("renders title, body and footer with an accessible dialog role", () => {
    render(
      <Dialog title="New task" onClose={() => {}} footer={<button>Create</button>}>
        <p>body text</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "New task" });
    expect(dialog.textContent).toContain("New task");
    expect(dialog.textContent).toContain("body text");
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
  });

  it("closes on the close button, Escape, and a click on the backdrop but not inside the panel", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Dialog title="Plan" onClose={onClose}>
        <input aria-label="goal" />
      </Dialog>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseDown(screen.getByLabelText("goal"));
    expect(onClose).toHaveBeenCalledTimes(2);

    const overlay = container.querySelector(".overlay")!;
    fireEvent.mouseDown(overlay);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("stops Escape from reaching listeners behind it and removes its listener on unmount", () => {
    const onClose = vi.fn();
    const behind = vi.fn();
    window.addEventListener("keydown", behind);
    const { unmount } = render(
      <Dialog title="Edit project" onClose={onClose}>
        x
      </Dialog>,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).not.toHaveBeenCalled();

    unmount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(behind).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", behind);
  });

  it("widens the panel when asked", () => {
    render(
      <Dialog title="Wide" onClose={() => {}} wide>
        x
      </Dialog>,
    );
    expect(screen.getByRole("dialog").getAttribute("style")).toContain("min(960px, 94vw)");
  });
});
