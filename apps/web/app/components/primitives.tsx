import type { ExperimentStatus } from "../experiment-contract";
import type { EventStatus } from "../trace-contract";

export function PanelHead({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="panel-head">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

export function Metric({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: EventStatus | ExperimentStatus;
}) {
  return (
    <div className={`fact ${tone ?? ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function InlineField({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <span className="inline-field" title={title}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

export function Payload({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="payload">
      <h4>{title}</h4>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

export function TraceSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}
