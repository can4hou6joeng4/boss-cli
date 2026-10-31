"""One host-policy contract for business, summary and connection model requests."""
from __future__ import annotations

import threading
from dataclasses import replace
from typing import Any

from boss_harness.hooks import MAX_CONTEXT_UNITS, LifecycleHooks
from boss_harness.models.provider import ModelConfig
from boss_harness.models.secret import redact_secrets
from boss_harness.models.types import (
    AssistantMessage, ChatMessage, ModelRequest, ModelTaskContext, RequestPurpose, ToolResultsMessage, UserMessage,
)
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


MAX_UNIT_PREVIEW_CHARS = 1_000


def history_units(messages: tuple[ChatMessage, ...]) -> list[tuple[int, int]]:
    """Split request messages into [start, end) spans that each begin at a user input."""
    starts = [index for index, message in enumerate(messages) if isinstance(message, UserMessage)]
    if not starts or starts[0] != 0:
        starts.insert(0, 0)
    return [(start, starts[i + 1] if i + 1 < len(starts) else len(messages))
            for i, start in enumerate(starts)] if messages else []


def _unit_view(index: int, messages: tuple[ChatMessage, ...]) -> dict[str, Any]:
    text = next((message.text for message in messages if isinstance(message, UserMessage)), "")
    tool_names = [call.name for message in messages if isinstance(message, AssistantMessage)
                  for call in message.tool_calls()]
    return {"index": index, "messageCount": len(messages),
            "userText": redact_secrets(text[:MAX_UNIT_PREVIEW_CHARS]), "userTextChars": len(text),
            "assistantTextChars": sum(len(message.text()) for message in messages if isinstance(message, AssistantMessage)),
            "toolNames": tool_names[:64], "toolCallCount": len(tool_names),
            "toolResultChars": sum(len(item.content) for message in messages if isinstance(message, ToolResultsMessage)
                                   for item in message.results)}


def transform_request_context(hooks: LifecycleHooks, config: ModelConfig, request: ModelRequest,
                              context: dict[str, Any], cancel_event: threading.Event | None) -> ModelRequest:
    """Apply host omissions of whole history units to this request only."""
    units = history_units(request.messages)
    if len(units) < 2:
        return request
    offset = max(0, len(units) - MAX_CONTEXT_UNITS)
    views = [_unit_view(index, request.messages[start:end])
             for index, (start, end) in enumerate(units) if index >= offset]
    outcome = hooks.transform_context({**context, "unitCount": len(units), "unitOffset": offset, "units": views},
                                      unit_count=len(units), cancel_event=cancel_event)
    if outcome is None or (cancel_event is not None and cancel_event.is_set()):
        return request
    if not isinstance(outcome, tuple):
        secret = config.api_key.get() if config.api_key else ""
        raise ModelRequestRejected(outcome.code, redact_secrets(outcome.message, extra=(secret,)), context)
    if not outcome:
        return request
    dropped = set(outcome)
    messages = tuple(message for index, (start, end) in enumerate(units) if index not in dropped
                     for message in request.messages[start:end])
    return replace(request, messages=messages)


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
    if task.purpose == "turn" and hooks.transforms_context:
        request = transform_request_context(hooks, config, request, context, cancel_event)
        if cancel_event is not None and cancel_event.is_set():
            return request
        context["messageCount"] = len(request.messages)
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
