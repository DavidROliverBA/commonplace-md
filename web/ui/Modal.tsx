// The one dialog frame: centred on a laptop, a bottom sheet on a phone (styles/overlays.css).
// Focus moves into it on open and back to where it was on close; Escape and a click outside
// close only the top-most one, so a confirm over Settings closes just the confirm. Tab and
// Shift-Tab cycle within the top-most one, never reaching the page behind it.
//
// `bare` drops the header and frame for a screen that draws its own box (the quick switcher):
// `className` styles the box, `top` places it near the top, and it keeps the same focus trap,
// Escape and focus return. `returnFocus` can decline the return when the dialog's choice moves
// focus somewhere new (opening a note).

import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "./Icon";

const stack: number[] = [];
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
let seq = 0;

export function Modal({
  title,
  onClose,
  children,
  size = "normal",
  bare = false,
  className,
  top = false,
  returnFocus,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: "small" | "normal" | "wide";
  bare?: boolean;
  className?: string;
  top?: boolean;
  returnFocus?: () => boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const returnRef = useRef(returnFocus);
  returnRef.current = returnFocus;
  // Where focus was, noted while rendering: by the time effects run, a child's autoFocus has
  // already moved it into the dialog.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement as HTMLElement | null;

  useEffect(() => {
    const id = ++seq;
    stack.push(id);
    const before = opener.current;
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
      if (returnRef.current?.() !== false) before?.focus?.();
    };
  }, []);

  if (bare)
    return (
      <div className={`modal-backdrop${top ? " top" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
        <div ref={box} className={className} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
          {children}
        </div>
      </div>
    );
  return (
    <div className={`modal-backdrop${top ? " top" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`modal modal-${size}${className ? ` ${className}` : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
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
