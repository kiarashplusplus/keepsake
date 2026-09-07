/**
 * Page-level drag-and-drop and clipboard-paste for picked photos.
 *
 * The bug this fixes first has nothing to do with images: with no `drop`
 * handler anywhere, dropping *any* file on the give flow made the browser
 * navigate to it, leaving the wizard. The draft survives in `sessionStorage`,
 * but `deserializeGiveDraft` nulls every `objectUrl` (blob URLs don't survive
 * a navigation), so the giver came back to a step with their tiles' previews
 * gone. Swallowing the drop is most of the value here; accepting the photo is
 * the rest.
 *
 * Listeners go on `document` rather than a specific element because the
 * useful target is "anywhere on this step" — and because getting a DOM node
 * out of a react-native-web `View` to attach to would be a second escape
 * hatch for no gain. The hook is only mounted by the photos step, so the
 * page-wide scope lasts exactly as long as that screen does.
 *
 * `dragover` must be `preventDefault`ed too, not just `drop`: without it the
 * browser never treats the page as a drop target and `drop` never fires.
 */
import * as React from "react";
import { validateSourceFile } from "@/lib/images/validateImage";

export type FileDropState = { isDraggingOver: boolean };

/**
 * Keeps files that are plausibly images, so dropping a folder or a zip
 * alongside a photo is ignored rather than turned into an error tile.
 *
 * Deliberately reuses `validateSourceFile` rather than testing
 * `type.startsWith("image/")`: that is the one place that knows an empty or
 * `application/octet-stream` type means "unknown, let the decode decide", and
 * a dropped file is exactly as likely to carry one as a picked file. A file
 * that *is* an image but fails for another reason (too large) is kept on
 * purpose — that deserves a visible error, not silence.
 */
function keepLikelyImages(files: File[]): File[] {
  return files.filter((file) => validateSourceFile(file) !== "unsupported_type");
}

function filesFromDataTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  return keepLikelyImages(Array.from(data.files));
}

export function useFileDrop(options: { onFiles: (files: File[]) => void; enabled: boolean }): FileDropState {
  const { onFiles, enabled } = options;
  const [isDraggingOver, setIsDraggingOver] = React.useState(false);

  // Held in a ref so the listener effect doesn't re-subscribe on every render
  // just because the caller passed a fresh closure. Written from an effect
  // rather than during render: a render-phase ref write is not safe under
  // concurrent rendering, since a render can be thrown away.
  const onFilesRef = React.useRef(onFiles);
  React.useEffect(() => {
    onFilesRef.current = onFiles;
  });

  React.useEffect(() => {
    if (typeof document === "undefined") return;

    // `dragenter`/`dragleave` fire for every child element the cursor crosses,
    // so a naive boolean flickers as the pointer moves over the page. Counting
    // enters against leaves is the standard fix.
    let dragDepth = 0;

    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      if (enabled) setIsDraggingOver(true);
    };

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      // Both of these are load-bearing: without preventDefault the drop never
      // fires, and without `dropEffect` the cursor shows a "move" affordance
      // for something we're going to copy.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = enabled ? "copy" : "none";
    };

    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setIsDraggingOver(false);
    };

    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      // Swallowed even when the step is full or disabled — the alternative is
      // the browser navigating away from a half-finished give.
      event.preventDefault();
      dragDepth = 0;
      setIsDraggingOver(false);
      if (!enabled) return;
      const files = filesFromDataTransfer(event.dataTransfer);
      if (files.length > 0) onFilesRef.current(files);
    };

    const onPaste = (event: ClipboardEvent): void => {
      if (!enabled) return;
      // Never steal a paste aimed at a text field — the give flow's later
      // steps are full of them, and this hook outlives none of them, but the
      // photos step still has focusable controls.
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || target?.isContentEditable === true) return;

      const files = filesFromDataTransfer(event.clipboardData);
      if (files.length === 0) return;
      event.preventDefault();
      onFilesRef.current(files);
    };

    document.addEventListener("dragenter", onDragEnter);
    document.addEventListener("dragover", onDragOver);
    document.addEventListener("dragleave", onDragLeave);
    document.addEventListener("drop", onDrop);
    document.addEventListener("paste", onPaste);

    return () => {
      document.removeEventListener("dragenter", onDragEnter);
      document.removeEventListener("dragover", onDragOver);
      document.removeEventListener("dragleave", onDragLeave);
      document.removeEventListener("drop", onDrop);
      document.removeEventListener("paste", onPaste);
    };
  }, [enabled]);

  return { isDraggingOver: enabled && isDraggingOver };
}
