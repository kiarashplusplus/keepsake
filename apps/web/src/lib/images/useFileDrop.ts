/**
 * Native stub. Metro's platform resolution picks `useFileDrop.web.ts` over
 * this file when bundling for web; this milestone is web-only (see
 * `pickImages.ts`, which is split the same way for the same reason).
 * Drag-and-drop and clipboard paste have no native analogue — the native
 * flip should use `expo-image-picker` for both picking and camera capture.
 */
export type FileDropState = { isDraggingOver: boolean };

export function useFileDrop(_options: { onFiles: (files: File[]) => void; enabled: boolean }): FileDropState {
  return { isDraggingOver: false };
}
