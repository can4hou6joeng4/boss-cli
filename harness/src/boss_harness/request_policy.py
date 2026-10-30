"""One host-policy contract for business, summary and connection model requests."""
from __future__ import annotations

import threading
from dataclasses import replace
from typing import Any

from boss_harness.hooks import LifecycleHooks
from boss_harness.models.provider import ModelConfig
from boss_harness.models.secret import redact_secrets
from boss_harness.models.types import ModelRequest, ModelTaskContext, RequestPurpose
from boss_harness.session import Entry, SessionStore


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
                        max_model_requests: int | None = None) -> ModelRequest:
    """Bind local ownership to the final request and check the same identity."""
    task = ModelTaskContext(purpose=purpose, request_index=request_index,
                            thread_id=thread_id, turn_id=turn_id, job_id=job_id)
    # Preparers may rebuild the request. The execution owner always supplies
    # the final identity, even without policy hooks; never infer a current run.
    request = replace(request, task_context=task)
    if hooks is None or (cancel_event is not None and cancel_event.is_set()):
        return request
    context = {"purpose": task.purpose, "provider": config.provider, "model": request.model,
               "requestIndex": task.request_index, "messageCount": len(request.messages),
               "toolCount": len(request.tools), "budget": budget}
    for key, value in (("threadId", task.thread_id), ("turnId", task.turn_id), ("jobId", task.job_id),
                       ("maxModelRequests", max_model_requests)):
        if value is not None or (task.purpose == "turn" and key in {"threadId", "turnId"}):
            context[key] = value
    decision = hooks.before_request(context, cancel_event=cancel_event)
    if cancel_event is not None and cancel_event.is_set():
        return request
    if decision is not None and not decision.allow:
        secret = config.api_key.get() if config.api_key else ""
        raise ModelRequestRejected(decision.code, redact_secrets(decision.message, extra=(secret,)), context)
    return request


def record_model_rejection(sessions: SessionStore, thread_id: str, error: ModelRequestRejected) -> None:
    """Keep the rejected request's identity when propagating through summary recovery."""
    if not error.recorded:
        sessions.append(thread_id, Entry(type="model_error", payload=error.payload()))
        error.recorded = True
