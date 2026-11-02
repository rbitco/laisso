import type { ReactNode } from "react";

/** One row of a Config sheet: its name and what it is for on the left, its contents on the right. */
export function Setting({ title, about, role, children }: { title: string; about: string; role?: string; children: ReactNode }) {
  return (
    <section className="setting" data-role={role}>
      <div>
        <h3>{title}</h3>
        <p className="about">{about}</p>
      </div>
      <div className="cfg-body">{children}</div>
    </section>
  );
}

/** A page head: the thing's name over the file it lives in, with its buttons on the right. */
export function EditorHead({ title, file, children }: { title: string; file: string; children?: ReactNode }) {
  return (
    <div className="ed-head">
      <div style={{ minWidth: 0 }}>
        <h2>{title}</h2>
        <span className="path">{file}</span>
      </div>
      <div className="bar">{children}</div>
    </div>
  );
}

/** A group of sheets that save the same way, titled with how. */
export function GroupTitle({ title, how }: { title: string; how: string }) {
  return (
    <h3 className="group-title">
      {title}
      <span>{how}</span>
    </h3>
  );
}
