// The one dialog frame: centred on a laptop, a bottom sheet on a phone (styles/overlays.css).
// Focus moves into it on open and back to where it was on close; Escape and a click outside
// close only the top-most one, so a confirm over Settings closes just the confirm. Tab and
// Shift-Tab cycle within the top-most one, never reaching the page behind it.

import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "./Icon";

const stack: number[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
let seq = 0;

export function Modal({ title, onClose, children, size = "normal" }: { title: string; onClose: () => void; children: ReactNode; size?: "small" | "normal" | "wide" }) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const id = ++seq;
    stack.push(id);
    const before = document.activeElement as HTMLElement | null;
    // Let children autofocus first (a prompt's input); otherwise focus the dialog itself.
    requestAnimationFrame(() => {
      if (box.current && !box.current.contains(document.activeElement)) box.current.focus();
    });
    const on = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      } else if (e.key === "Tab" && box.current) {
        const all = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (!all.length) return;
        const first = all[0]!;
        const last = all[all.length - 1]!;
        const at = document.activeElement;
        const inside = box.current.contains(at);
        if (e.shiftKey && (at === first || at === box.current || !inside)) (e.preventDefault(), last.focus());
        else if (!e.shiftKey && (at === last || !inside)) (e.preventDefault(), first.focus());
      }
    };
    window.addEventListener("keydown", on, true);
    return () => {
      window.removeEventListener("keydown", on, true);
      stack.splice(stack.indexOf(id), 1);
      before?.focus?.();
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header>
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
