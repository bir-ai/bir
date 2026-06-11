import type { CSSProperties } from "react";
import {
  getPromptDetails,
  getRetrievalDetails,
  type TraceTimelineRow,
} from "../trace-contract";
import { formatCost, formatDuration, formatNumber, formatUsage } from "./format";
import { statusLabels, typeLabels } from "./labels";
import { InlineField, Payload } from "./primitives";
import { PromptPanel, RetrievalPanel } from "./trace-detail-panels";

export function TraceTimeline({ rows }: { rows: TraceTimelineRow[] }) {
  return (
    <div className="timeline">
      {rows.map((row) => (
        <EventRow row={row} key={row.event.id} />
      ))}
    </div>
  );
}

function EventRow({ row }: { row: TraceTimelineRow }) {
  const { event } = row;
  const eventIndent = Math.min(row.depth, 6) * 28;
  const hasInput = event.input !== null && event.input !== undefined;
  const hasOutput = event.output !== null && event.output !== undefined;
  const hasMetadata = Object.keys(event.metadata ?? {}).length > 0;
  const hasUsage = event.usage && Object.keys(event.usage).length > 0;
  const hasCost = event.cost && Object.keys(event.cost).length > 0;
  const promptDetails = getPromptDetails(event);
  const retrievalDetails = getRetrievalDetails(event);

  return (
    <article
      className={`event-row ${event.type}${row.isOrphan ? " orphan" : ""}`}
      style={{ "--event-indent": `${eventIndent}px` } as CSSProperties}
    >
      <div className="timeline-rail">
        <span className={`event-node ${event.status}`} />
      </div>
      <div className="event-body">
        <div className="event-title-line">
          <div>
            <span className="event-type">{typeLabels[event.type]}</span>
            <h3>{event.name}</h3>
          </div>
          <div className="event-badges">
            {row.isOrphan ? <span className="orphan-pill">Orphan</span> : null}
            <span className={`status-pill ${event.status}`}>{statusLabels[event.status]}</span>
            <span className="duration-pill">{formatDuration(event.start_time, event.end_time)}</span>
          </div>
        </div>

        <div className="event-fields">
          {event.model ? <InlineField label="Model" value={event.model} /> : null}
          {event.type === "score" && typeof event.value === "number" ? (
            <InlineField label="Score" value={formatNumber(event.value)} />
          ) : null}
          {hasUsage ? <InlineField label="Usage" value={formatUsage(event.usage)} /> : null}
          {hasCost ? <InlineField label="Cost" value={formatCost(event.cost, event.currency)} /> : null}
          {event.parent_id ? <InlineField label="Parent" value={event.parent_id} /> : null}
        </div>

        {event.error ? <pre className="error-block">{event.error}</pre> : null}

        {promptDetails ? <PromptPanel details={promptDetails} /> : null}
        {retrievalDetails ? <RetrievalPanel details={retrievalDetails} /> : null}

        <div className="payload-grid">
          {hasInput && !retrievalDetails ? <Payload title="Input" value={event.input} /> : null}
          {hasOutput && !retrievalDetails ? <Payload title="Output" value={event.output} /> : null}
          {hasMetadata ? <Payload title="Metadata" value={event.metadata} /> : null}
        </div>
      </div>
    </article>
  );
}
