"""
Small WebSocket event bridge for assistant progress and chunked output.

Flask's development server is kept as-is on port 5000. This module starts an
optional lightweight WebSocket server in a background thread, using the
`websockets` package already listed in the project environment.
"""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from typing import Any


_clients: dict[str, Any] = {}
_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.RLock()
_server_started = False
_server_enabled = False
_server_error: str | None = None
_server_port = int(os.environ.get("AGENT_WS_PORT", "5001"))


def start_realtime_server(host: str = "127.0.0.1", port: int | None = None) -> bool:
    """Start the background WebSocket server once."""

    global _server_started, _server_enabled, _server_error, _server_port
    if port is not None:
        _server_port = int(port)
    else:
        _server_port = int(os.environ.get("AGENT_WS_PORT", _server_port))

    with _lock:
        if _server_started:
            return _server_enabled
        _server_started = True

    try:
        from websockets.sync.server import serve
    except Exception as exc:  # pragma: no cover - depends on local env package
        _server_error = f"websockets package unavailable: {exc}"
        print(f"[agent/ws] disabled: {_server_error}")
        return False

    def run() -> None:
        global _server_enabled, _server_error
        try:
            with serve(_handle_socket, host, _server_port) as server:
                _server_enabled = True
                print(f"[agent/ws] listening on ws://{host}:{_server_port}/ws")
                server.serve_forever()
        except Exception as exc:  # pragma: no cover - runtime server failures
            _server_enabled = False
            _server_error = str(exc)
            print(f"[agent/ws] failed: {_server_error}")

    thread = threading.Thread(target=run, name="agent-websocket", daemon=True)
    thread.start()
    return True


def get_realtime_config() -> dict[str, Any]:
    with _lock:
        return {
            "enabled": _server_enabled,
            "started": _server_started,
            "port": _server_port,
            "clients": len(_clients),
            "jobs": [_serialize_job(job) for job in _jobs.values()],
            "error": _server_error,
        }


def create_job(
    *,
    client_id: str | None,
    job_type: str,
    label: str,
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    if not client_id:
        return None

    with _lock:
        if client_id not in _clients:
            return None

        now = _now()
        job = {
            "id": f"job_{int(datetime.now().timestamp() * 1000)}_{uuid.uuid4().hex[:8]}",
            "clientId": client_id,
            "type": job_type,
            "label": label,
            "status": "running",
            "metadata": metadata or {},
            "events": [],
            "cancelled": False,
            "createdAt": now,
            "updatedAt": now,
        }
        _jobs[job["id"]] = job

    _send_job_event(job, "job_started", {"job": _serialize_job(job)})
    return job


def emit_progress(
    job: dict[str, Any] | None,
    *,
    stage: str,
    message: str,
    data: dict[str, Any] | list[Any] | None = None,
) -> None:
    if not job:
        return

    with _lock:
        stored = _jobs.get(job["id"])
        if not stored or stored["status"] != "running":
            return
        event = {
            "stage": stage,
            "message": message,
            "data": data,
            "createdAt": _now(),
        }
        stored["events"].append(event)
        stored["events"] = stored["events"][-20:]
        stored["updatedAt"] = event["createdAt"]

    _send_job_event(
        stored,
        "job_progress",
        {
            "jobId": stored["id"],
            "status": stored["status"],
            **event,
        },
    )


def emit_token(job: dict[str, Any] | None, *, text: str, accumulated_text: str | None = None) -> None:
    if not job or not text:
        return

    with _lock:
        stored = _jobs.get(job["id"])
        if not stored or stored["status"] != "running":
            return
        stored["updatedAt"] = _now()

    _send_job_event(
        stored,
        "llm_token",
        {
            "jobId": stored["id"],
            "status": stored["status"],
            "text": text,
            "accumulatedText": accumulated_text,
            "createdAt": stored["updatedAt"],
        },
    )


def complete_job(job: dict[str, Any] | None, result: dict[str, Any] | None = None) -> None:
    _finish_job(job, "completed", "job_completed", {"result": result or {}})


def fail_job(job: dict[str, Any] | None, error: Exception | str) -> None:
    message = str(error)
    _finish_job(job, "failed", "job_failed", {"error": message})


def is_cancelled(job: dict[str, Any] | None) -> bool:
    if not job:
        return False
    with _lock:
        return bool(_jobs.get(job["id"], {}).get("cancelled"))


def _finish_job(
    job: dict[str, Any] | None,
    status: str,
    event_type: str,
    payload: dict[str, Any],
) -> None:
    if not job:
        return

    with _lock:
        stored = _jobs.get(job["id"])
        if not stored or stored["status"] not in ("running", status):
            return
        stored["status"] = status
        stored["updatedAt"] = _now()

    _send_job_event(
        stored,
        event_type,
        {
            "jobId": stored["id"],
            "status": status,
            **payload,
        },
    )


def _handle_socket(socket: Any) -> None:
    client_id = uuid.uuid4().hex
    with _lock:
        _clients[client_id] = socket

    _send_socket(
        socket,
        {
            "type": "ws_connected",
            "clientId": client_id,
            "serverTime": _now(),
            "jobs": _client_jobs(client_id),
        },
    )

    try:
        for raw_message in socket:
            _handle_client_message(client_id, raw_message)
    finally:
        with _lock:
            _clients.pop(client_id, None)


def _handle_client_message(client_id: str, raw_message: Any) -> None:
    try:
        message = json.loads(str(raw_message or ""))
    except json.JSONDecodeError:
        _send_to_client(client_id, {"type": "ws_error", "error": "invalid_json"})
        return

    if message.get("type") == "cancel_job":
        job_id = str(message.get("jobId") or "")
        with _lock:
            job = _jobs.get(job_id)
            if job and job.get("clientId") == client_id and job["status"] == "running":
                job["cancelled"] = True
                job["status"] = "cancelled"
                job["updatedAt"] = _now()
            else:
                job = None

        if job:
            _send_job_event(
                job,
                "job_cancelled",
                {"jobId": job_id, "status": "cancelled", "reason": "cancelled_by_user"},
            )
        else:
            _send_to_client(client_id, {"type": "ws_error", "error": "job_not_found", "jobId": job_id})
        return

    if message.get("type") == "ping":
        _send_to_client(client_id, {"type": "pong", "serverTime": _now()})


def _send_job_event(job: dict[str, Any], event_type: str, payload: dict[str, Any]) -> None:
    _send_to_client(job["clientId"], {"type": event_type, **payload})


def _send_to_client(client_id: str, payload: dict[str, Any]) -> None:
    with _lock:
        socket = _clients.get(client_id)
    if socket is not None:
        _send_socket(socket, payload)


def _send_socket(socket: Any, payload: dict[str, Any]) -> None:
    try:
        socket.send(json.dumps(payload, ensure_ascii=False, default=str))
    except Exception:
        pass


def _client_jobs(client_id: str) -> list[dict[str, Any]]:
    with _lock:
        return [_serialize_job(job) for job in _jobs.values() if job["clientId"] == client_id and job["status"] == "running"]


def _serialize_job(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": job["id"],
        "type": job["type"],
        "label": job["label"],
        "status": job["status"],
        "metadata": job.get("metadata", {}),
        "events": list(job.get("events", []))[-20:],
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
    }


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()
