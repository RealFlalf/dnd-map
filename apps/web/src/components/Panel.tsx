import { useId, useState, type ReactNode } from 'react';

const KEY = 'dnd-map:collapsed-panels';

const readCollapsed = (): string[] => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const writeCollapsed = (id: string, collapsed: boolean) => {
  try {
    const rest = readCollapsed().filter((x) => x !== id);
    localStorage.setItem(KEY, JSON.stringify(collapsed ? [...rest, id] : rest));
  } catch {
    // private mode: the panel simply opens again next time
  }
};

interface Props {
  /** Stable name; remembers whether the panel is folded. */
  id: string;
  title: ReactNode;
  children: ReactNode;
}

/** A sidebar section the user can fold away; the choice is remembered in this browser. */
export function Panel({ id, title, children }: Props) {
  const [open, setOpen] = useState(() => !readCollapsed().includes(id));
  const bodyId = useId();

  const toggle = () => {
    writeCollapsed(id, open);
    setOpen(!open);
  };

  return (
    <section className="panel">
      <h3>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={toggle}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {title}
        </button>
      </h3>
      {/* Hidden, not removed: half-typed values and selections survive folding. */}
      <div id={bodyId} className="panel-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
