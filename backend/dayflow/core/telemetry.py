"""OpenTelemetry → Cloud Trace.

Google ADK already emits a span per agent invocation, per LLM call and per tool call; all this module does
is give those spans a destination. On Cloud Run (`K_SERVICE` set) or with `DAYFLOW_TRACE=1` it installs a
global TracerProvider that batches to Cloud Trace, and one run then reads as a waterfall in the console:
invocation → LLM call → tool → the next LLM call.

Everything here is optional. Without the exporter package, without credentials, or when the export fails,
the brain runs exactly as before: `init_tracing()` returns False and nothing else changes. Telemetry never
raises into a request.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger("dayflow.telemetry")

SERVICE_NAME = "dayflow-brain"
# ADK attaches the full LLM request/response and every tool's arguments and result to its spans unless this
# is off — that is page snapshots, prompts and file paths sitting in Cloud Trace. Spans stay (the waterfall
# is the point); their content does not, unless the operator asks for it with DAYFLOW_TRACE_CONTENT=1.
CONTENT_ENV = "ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS"
_initialised = False


def tracing_enabled() -> bool:
    return bool(os.getenv("K_SERVICE")) or os.getenv("DAYFLOW_TRACE") == "1"


def init_tracing(service_name: str = SERVICE_NAME) -> bool:
    """Installs the Cloud Trace exporter once. Returns whether tracing is now on."""
    global _initialised
    if _initialised:
        return True
    if not tracing_enabled():
        return False
    os.environ.setdefault(CONTENT_ENV, "true" if os.getenv("DAYFLOW_TRACE_CONTENT") == "1" else "false")
    try:
        # Imported lazily: `opentelemetry-exporter-gcp-trace` is optional and absent in most local setups.
        from opentelemetry import trace

        # Deprecated upstream in favour of OTLP to telemetry.googleapis.com, still the one-line path to
        # Cloud Trace and still supported; swapping it is a change of these three lines.
        from opentelemetry.exporter.cloud_trace import CloudTraceSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor

        project = os.getenv("GOOGLE_CLOUD_PROJECT") or None
        resource = Resource.create(
            {"service.name": service_name, "service.instance.id": os.getenv("K_REVISION", "local")}
        )
        provider = TracerProvider(resource=resource)  # shuts itself down (and flushes) at exit
        provider.add_span_processor(BatchSpanProcessor(CloudTraceSpanExporter(project_id=project)))
        trace.set_tracer_provider(provider)
    except Exception as e:  # noqa: BLE001 — a missing exporter or missing credentials must cost nothing
        log.info("tracing off (%s: %s)", type(e).__name__, e)
        return False
    _initialised = True
    log.info("tracing on: exporting spans to Cloud Trace (project=%s)", os.getenv("GOOGLE_CLOUD_PROJECT") or "default")
    return True
