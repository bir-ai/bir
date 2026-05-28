<p align="center">
  <img src="bir_logo.png" alt="bir logo" width="160">
</p>

# bir

LLM Evaluation, Tracing & Observability Platform

Bir is an early-stage toolkit for tracing and evaluating LLM applications.

Current focus:

- Python SDK
- Local trace storage
- Trace, span, and score recording
- Safe opt-in input/output capture

## Python SDK

```python
from bir import observe, score, span

@observe()
def answer_question(question: str) -> str:
    with span("retrieve_context"):
        context = "local context"

    score("helpfulness", 0.82)
    return f"{context}: {question}"
```

Traces are written locally to `.bir/traces.jsonl`. Run the FastAPI server and
send local events when you want to inspect them through the ingestion API:

```python
from bir import send_events

send_events("http://127.0.0.1:8000")
```
