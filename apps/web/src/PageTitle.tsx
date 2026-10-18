import type { ReactNode } from "react";
import "./PageTitle.css";

export function PageTitle({
  eyebrow,
  title,
  description,
  portrait,
  children,
  className = "",
  as: Tag = "div",
  "aria-label": ariaLabel,
}: {
  eyebrow: string;
  title: string;
  description: string;
  portrait?: ReactNode;
  children?: ReactNode;
  className?: string;
  as?: "div" | "header" | "section";
  "aria-label"?: string;
}) {
  return (
    <Tag className={`title page-title ${className}`} aria-label={ariaLabel}>
      <div className="page-title-copy">
        <span className="page-title-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="page-title-description">{description}</p>
      </div>
      {portrait && (
        <div className="page-title-portrait" aria-hidden="true">
          {portrait}
        </div>
      )}
      {children && <div className="page-title-extra">{children}</div>}
    </Tag>
  );
}
