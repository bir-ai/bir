import type { GenerationChatDetails, PromptDetails, RetrievalDetails } from "../trace-contract";
import { formatNumber, formatPayloadValue } from "./format";
import { InlineField, Payload } from "./primitives";

export function GenerationPanel({ details }: { details: GenerationChatDetails }) {
  return (
    <section className="generation-panel">
      <h4>Conversation</h4>
      <div className="generation-messages">
        {details.messages.map((message, index) => (
          <article className={`generation-message ${message.role}`} key={`${message.role}-${index}`}>
            <span className="message-role">{message.role}</span>
            <pre>{message.content}</pre>
          </article>
        ))}
        {details.outputText !== null ? (
          <article className="generation-message assistant">
            <span className="message-role">assistant reply</span>
            <pre>{details.outputText}</pre>
          </article>
        ) : null}
      </div>
    </section>
  );
}

export function PromptPanel({ details }: { details: PromptDetails }) {
  return (
    <section className="prompt-panel">
      <div className="prompt-head">
        <h4>Prompt</h4>
        <div className="event-fields">
          <InlineField label="Name" value={details.name} />
          {details.version ? <InlineField label="Version" value={details.version} /> : null}
          {details.template_sha256 ? <InlineField label="Template SHA-256" value={details.template_sha256} /> : null}
        </div>
      </div>
      <div className="prompt-payload-grid">
        {details.template ? <Payload title="Template" value={details.template} /> : null}
        {details.variables ? <Payload title="Variables" value={details.variables} /> : null}
        {details.rendered ? <Payload title="Rendered" value={details.rendered} /> : null}
        {details.metadata ? <Payload title="Prompt Metadata" value={details.metadata} /> : null}
      </div>
    </section>
  );
}

export function RetrievalPanel({ details }: { details: RetrievalDetails }) {
  const hasQuery = details.query !== null && details.query !== undefined;

  return (
    <section className="retrieval-panel">
      <div className="retrieval-query">
        <h4>Query</h4>
        {hasQuery ? <pre>{formatPayloadValue(details.query)}</pre> : <p>No query captured.</p>}
      </div>

      <div className="retrieval-docs">
        <h4>Documents</h4>
        {details.documents.length > 0 ? (
          <div className="retrieval-doc-list">
            {details.documents.map((document, index) => (
              <article className="retrieval-doc" key={`${document.id ?? "document"}-${index}`}>
                <div className="retrieval-doc-head">
                  <strong>{document.id ?? `Document ${index + 1}`}</strong>
                  <div className="event-badges">
                    {typeof document.rank === "number" ? (
                      <span className="doc-chip">Rank {formatNumber(document.rank)}</span>
                    ) : null}
                    {typeof document.score === "number" ? (
                      <span className="doc-chip">Score {formatNumber(document.score)}</span>
                    ) : null}
                    {document.source ? <span className="doc-chip">{document.source}</span> : null}
                  </div>
                </div>
                {document.text ? <p className="retrieval-text">{document.text}</p> : null}
                {document.metadata ? <pre className="retrieval-metadata">{JSON.stringify(document.metadata, null, 2)}</pre> : null}
              </article>
            ))}
          </div>
        ) : (
          <p>No documents captured.</p>
        )}
      </div>
    </section>
  );
}
