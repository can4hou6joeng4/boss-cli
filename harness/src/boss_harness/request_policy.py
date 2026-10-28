"""One host-policy contract for business, summary and connection model requests."""
from __future__ import annotations

import threading
from typing import Any, Literal

from boss_harness.hooks import LifecycleHooks
from boss_harness.models.provider import ModelConfig
from boss_harness.models.secret import redact_secrets
from boss_harness.models.types import ModelRequest
from boss_harness.session import Entry, SessionStore


RequestPurpose = Literal["turn", "compaction", "connection_check"]


class ModelRequestRejected(ValueError):
    """A terminal host refusal, separate from provider errors and cancellation."""

    def __init__(self, code: str, message: str, context: dict[str, Any]) -> None:
        super().__init__(message)
        self.code = code
        self.context = {key: context[key] for key in
                        ("purpose", "provider", "model", "requestIndex", "threadId", "turnId", "jobId")
                        if key in context}
        self.recorded = False

    def payload(self) -> dict[str, Any]:
        return {**self.context, "code": self.code, "message": str(self),
                "errorInfo": {"source": "request_policy", "code": self.code},
                "outputObserved": False, "contextRecoveryEligible": False, "requestRejected": True}


def check_model_request(hooks: LifecycleHooks | None, config: ModelConfig, request: ModelRequest,
                        budget: dict[str, Any], *, purpose: RequestPurpose, request_index: int,
                        cancel_event: threading.Event | None = None, thread_id: str | None = None,
                        turn_id: str | None = None, job_id: str | None = None,
                        max_model_requests: int | None = None) -> None:
    """Check the final prepared request without exposing prompts or credentials."""
    if hooks is None or (cancel_event is not None and cancel_event.is_set()):
        return
    context = {"purpose": purpose, "provider": config.provider, "model": request.model,
               "requestIndex": request_index, "messageCount": len(request.messages),
               "toolCount": len(request.tools), "budget": budget}
    for key, value in (("threadId", thread_id), ("turnId", turn_id), ("jobId", job_id),
                       ("maxModelRequests", max_model_requests)):
        if value is not None or (purpose == "turn" and key in {"threadId", "turnId"}):
            context[key] = value
    decision = hooks.before_request(context, cancel_event=cancel_event)
    if cancel_event is not None and cancel_event.is_set():
        return
    if decision is not None and not decision.allow:
        secret = config.api_key.get() if config.api_key else ""
        raise ModelRequestRejected(decision.code, redact_secrets(decision.message, extra=(secret,)), context)


def record_model_rejection(sessions: SessionStore, thread_id: str, error: ModelRequestRejected) -> None:
    """Keep the rejected request's identity when propagating through summary recovery."""
    if not error.recorded:
        sessions.append(thread_id, Entry(type="model_error", payload=error.payload()))
        error.recorded = True
