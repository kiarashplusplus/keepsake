import * as React from "react";
import { render, act } from "@testing-library/react-native";
import { useFileDrop } from "@/lib/images/useFileDrop.web";

function imageFile(name = "photo.jpg", type = "image/jpeg"): File {
  return new File([new Uint8Array(8)], name, { type });
}

function Probe({ onFiles, enabled = true }: { onFiles: (files: File[]) => void; enabled?: boolean }): null {
  useFileDrop({ onFiles, enabled });
  return null;
}

function dragEventWithFiles(type: string, files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { files, types: ["Files"], dropEffect: "none" },
  });
  return event;
}

describe("useFileDrop", () => {
  it("accepts dropped image files", () => {
    const onFiles = jest.fn();
    render(<Probe onFiles={onFiles} />);

    act(() => {
      document.dispatchEvent(dragEventWithFiles("drop", [imageFile()]));
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]).toHaveLength(1);
  });

  // The actual harm the hook exists to stop: with no handler, the browser
  // navigates to the dropped file and the giver loses their place in the
  // wizard (and every tile preview, since blob URLs don't survive it).
  it("swallows the drop so the browser cannot navigate away", () => {
    render(<Probe onFiles={jest.fn()} />);
    const event = dragEventWithFiles("drop", [imageFile()]);

    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  // Without preventDefault on dragover the browser never treats the page as a
  // drop target and `drop` never fires at all.
  it("prevents dragover so the drop can happen", () => {
    render(<Probe onFiles={jest.fn()} />);
    const event = dragEventWithFiles("dragover", [imageFile()]);

    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
  });

  it("still swallows a drop when the step is full, rather than navigating", () => {
    const onFiles = jest.fn();
    render(<Probe onFiles={onFiles} enabled={false} />);
    const event = dragEventWithFiles("drop", [imageFile()]);

    act(() => {
      document.dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(true);
    expect(onFiles).not.toHaveBeenCalled();
  });

  it("ignores dropped files that aren't images", () => {
    const onFiles = jest.fn();
    render(<Probe onFiles={onFiles} />);

    act(() => {
      document.dispatchEvent(dragEventWithFiles("drop", [new File([""], "a.zip", { type: "application/zip" })]));
    });

    expect(onFiles).not.toHaveBeenCalled();
  });

  // A picker that reports no MIME type is the Android case `validateSourceFile`
  // defers to the decode; a dropped file deserves the same benefit of the doubt.
  it("keeps a dropped file whose type the OS didn't report", () => {
    const onFiles = jest.fn();
    render(<Probe onFiles={onFiles} />);

    act(() => {
      document.dispatchEvent(dragEventWithFiles("drop", [imageFile("IMG_1.HEIC", "")]));
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("accepts a pasted image", () => {
    const onFiles = jest.fn();
    render(<Probe onFiles={onFiles} />);

    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [imageFile()], types: ["Files"] } });

    act(() => {
      document.dispatchEvent(event);
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
  });

  it("leaves a paste into a text field alone", () => {
    const onFiles = jest.fn();
    render(<Probe onFiles={onFiles} />);

    const input = document.createElement("input");
    document.body.appendChild(input);
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files: [imageFile()], types: ["Files"] } });

    act(() => {
      input.dispatchEvent(event);
    });

    expect(onFiles).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("removes its listeners on unmount", () => {
    const onFiles = jest.fn();
    const { unmount } = render(<Probe onFiles={onFiles} />);
    unmount();

    act(() => {
      document.dispatchEvent(dragEventWithFiles("drop", [imageFile()]));
    });

    expect(onFiles).not.toHaveBeenCalled();
  });
});
