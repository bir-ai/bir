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
      {rows.map((row, index) => (
        <EventRow row={row} rail={buildRailGuides(rows, index)} key={row.event.id} />
      ))}
    </div>
  );
}

const MAX_RAIL_DEPTH = 6;
const RAIL_STEP = 28;

type RailGuides = {
  depth: number;
  passLevels: number[];
  hasLaterSibling: boolean;
  hasChild: boolean;
};

function buildRailGuides(rows: TraceTimelineRow[], index: number): RailGuides {
  const depth = Math.min(rows[index].depth, MAX_RAIL_DEPTH);
  const passLevels: number[] = [];
  let hasLaterSibling = false;

  for (let level = 0; level < depth; level += 1) {
    const continues = levelContinuesBelow(rows, index, level + 1);
    if (level === depth - 1) {
      hasLaterSibling = continues;
    } else if (continues) {
      passLevels.push(level);
    }
  }

  return {
    depth,
    passLevels,
    hasLaterSibling,
    hasChild: index + 1 < rows.length && rows[index + 1].depth === rows[index].depth + 1,
  };
}

// A vertical guide keeps running past this row when the nearest following row at
// or above that level is a sibling (same depth) rather than the end of the branch.
function levelContinuesBelow(rows: TraceTimelineRow[], index: number, childDepth: number): boolean {
  for (let next = index + 1; next < rows.length; next += 1) {
    if (rows[next].depth <= childDepth) {
      return rows[next].depth === childDepth;
    }
  }
  return false;
}

function railLineOffset(levelsFromNode: number): string {
  return `${4.5 + RAIL_STEP * levelsFromNode}px`;
}

function EventRow({ row, rail }: { row: TraceTimelineRow; rail: RailGuides }) {
  const { event } = row;
  const eventIndent = rail.depth * RAIL_STEP;
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
        {rail.passLevels.map((level) => (
          <span
            key={level}
            className="rail-line rail-pass"
            style={{ right: railLineOffset(rail.depth - level) }}
          />
        ))}
        {rail.depth > 0 ? (
          <>
            <span
              className={`rail-line ${rail.hasLaterSibling ? "rail-tee" : "rail-elbow"}`}
              style={{ right: railLineOffset(1) }}
            />
            <span className="rail-link" />
          </>
        ) : null}
        {rail.hasChild ? (
          <span className="rail-line rail-descend" style={{ right: railLineOffset(0) }} />
        ) : null}
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
