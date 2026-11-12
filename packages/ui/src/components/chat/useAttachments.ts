import { useCallback, useState, type ClipboardEvent, type DragEvent } from "react";
import { errorMessage } from "../../lib/format";
import { refusal, type Attachment } from "./attachments";

let nextId = 0;

/**
 * Files dropped or pasted onto the composer (decision 62): text files become pills and go out with the next message;
 * anything else is refused with one line saying why. `dragging` drives the drop highlight.
 */
export function useAttachments(onImages?: (files: File[]) => void) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const add = useCallback(
    (all: readonly File[]) => {
      const images = onImages ? all.filter((f) => f.type.startsWith("image/")) : [];
      if (images.length) onImages?.(images);
      const list = onImages ? all.filter((f) => !f.type.startsWith("image/")) : all;
      const notes: string[] = [];
      for (const f of list) {
        const why = refusal(f.name, f.type, f.size);
        if (why) {
          notes.push(why);
          continue;
        }
        const id = `att${(nextId += 1)}`;
        f.text().then(
          (text) => setFiles((cur) => (cur.some((x) => x.name === f.name && x.text === text) ? cur : [...cur, { id, name: f.name, size: f.size, text }])),
          (e: unknown) => setNote(`Couldn't read ${f.name}: ${errorMessage(e)}. Try attaching it again.`),
        );
      }
      setNote(notes.length ? notes.join(" ") : null);
    },
    [onImages],
  );

  const remove = useCallback((id: string) => setFiles((cur) => cur.filter((f) => f.id !== id)), []);
  const clear = useCallback(() => {
    setFiles([]);
    setNote(null);
  }, []);

  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const dropProps = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget instanceof Node && e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
      setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      add([...e.dataTransfer.files]);
    },
  };
  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...e.clipboardData.files];
    if (!pasted.length) return;
    e.preventDefault();
    add(pasted);
  };

  return { files, note, dismissNote: () => setNote(null), dragging, remove, clear, dropProps, onPaste, add };
}
