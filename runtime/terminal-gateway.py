#!/usr/bin/env python3
"""LinuxForge V49 edge terminal gateway.

Browser-facing WebSocket gateway. It accepts short-lived HMAC tickets minted by
LinuxForge's authenticated application server and proxies only PTY operations
to a local/runtime HTTP service. No runtime credential is ever sent to a
browser.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import select
import socket
import struct
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional, Tuple

BIND = os.environ.get("FORGE_TERMINAL_GATEWAY_BIND", "127.0.0.1")
PORT = int(os.environ.get("FORGE_TERMINAL_GATEWAY_PORT", "18081"))
ALLOWED_ORIGIN = os.environ.get("FORGE_TERMINAL_ALLOWED_ORIGIN", "")
RUNTIME = os.environ.get("FORGE_RUNTIME_HTTP_ENDPOINT", "http://127.0.0.1:18080").rstrip("/")
RUNTIME_TOKEN = os.environ.get("FORGE_RUNTIME_SERVICE_TOKEN", "")
TICKET_SECRET = os.environ.get("FORGE_TERMINAL_TICKET_SECRET", "").encode()
MAX_OUTPUT_BYTES = int(os.environ.get("FORGE_TERMINAL_MAX_OUTPUT_BYTES", "64000"))

# Configurable resource exhaustion and protocol protection limits
MAX_CONNECTIONS = int(os.environ.get("FORGE_TERMINAL_MAX_CONNECTIONS", "50"))
MAX_FRAME_SIZE = int(os.environ.get("FORGE_TERMINAL_MAX_FRAME_SIZE", "16384"))
MAX_INPUT_BYTES = int(os.environ.get("FORGE_TERMINAL_MAX_INPUT_BYTES", "16384"))
MAX_MESSAGE_SIZE = int(os.environ.get("FORGE_TERMINAL_MAX_MESSAGE_SIZE", "65536"))
MAX_HEADER_SIZE = int(os.environ.get("FORGE_TERMINAL_MAX_HEADER_SIZE", "8192"))
IDLE_TIMEOUT = float(os.environ.get("FORGE_TERMINAL_IDLE_TIMEOUT", "300.0"))
SESSION_TIMEOUT = float(os.environ.get("FORGE_TERMINAL_SESSION_TIMEOUT", "3600.0"))

# RFC 6455 Opcodes
OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA

# RFC 6455 Close Status Codes
CLOSE_NORMAL = 1000
CLOSE_GOING_AWAY = 1001
CLOSE_PROTOCOL_ERROR = 1002
CLOSE_UNSUPPORTED_DATA = 1003
CLOSE_INVALID_PAYLOAD = 1007
CLOSE_POLICY_VIOLATION = 1008
CLOSE_MESSAGE_TOO_BIG = 1009
CLOSE_INTERNAL_ERROR = 1011

SUPPORTED_SIGNALS = {"SIGINT", "SIGTERM", "SIGTSTP", "EOF"}


class GatewayError(Exception):
    """Base error for terminal gateway operations."""
    pass


class WebSocketProtocolError(GatewayError):
    """WebSocket protocol error with RFC 6455 close status code."""
    def __init__(self, code: int = CLOSE_PROTOCOL_ERROR, message: str = "Protocol violation"):
        super().__init__(message)
        self.code = code
        self.message = message


class ConnectionLimiter:
    """Thread-safe connection counter protecting against resource exhaustion."""
    def __init__(self, max_connections: int):
        self.max_connections = max_connections
        self._count = 0
        self._lock = threading.Lock()

    def acquire(self) -> bool:
        with self._lock:
            if self._count >= self.max_connections:
                return False
            self._count += 1
            return True

    def release(self) -> None:
        with self._lock:
            if self._count > 0:
                self._count -= 1

    @property
    def count(self) -> int:
        with self._lock:
            return self._count


CONNECTION_LIMITER = ConnectionLimiter(MAX_CONNECTIONS)


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def ub64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * ((4 - len(s) % 4) % 4))


def is_safe_id(value: Any) -> bool:
    if not isinstance(value, str) or not value or len(value) > 128:
        return False
    return bool(re.match(r"^[a-zA-Z0-9_\-\.:]+$", value))


def verify_ticket(token: str) -> dict:
    if not TICKET_SECRET:
        raise GatewayError("Terminal ticket secret is not configured")
    if not isinstance(token, str):
        raise GatewayError("Invalid terminal ticket format")
    parts = token.split(".")
    if len(parts) != 2:
        raise GatewayError("Invalid terminal ticket")
    payload_str, sig = parts
    if not payload_str or not sig:
        raise GatewayError("Invalid terminal ticket structure")
    expected = b64u(hmac.new(TICKET_SECRET, payload_str.encode("utf-8"), hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        raise GatewayError("Invalid terminal ticket signature")
    try:
        data = json.loads(ub64(payload_str).decode("utf-8"))
    except Exception as exc:
        raise GatewayError("Invalid terminal ticket encoding") from exc
    if not isinstance(data, dict):
        raise GatewayError("Invalid terminal ticket payload")

    exp = data.get("exp")
    if not isinstance(exp, (int, float)) or isinstance(exp, bool) or int(exp) < int(time.time()):
        raise GatewayError("Terminal ticket expired")

    for key in ("userId", "labId", "environmentId", "sessionId"):
        val = data.get(key)
        if not is_safe_id(val):
            raise GatewayError(f"Invalid terminal ticket claims: {key}")

    for key in ("bindingGeneration", "runtimeLifecycleGeneration"):
        val = data.get(key)
        if not isinstance(val, int) or isinstance(val, bool) or val < 1:
            raise GatewayError("Invalid terminal ticket generation claims")

    shell = data.get("shell")
    if shell is not None and shell not in ("bash", "sh", "zsh"):
        raise GatewayError("Invalid terminal ticket shell claim")

    cwd = data.get("cwd")
    if cwd is not None:
        if not isinstance(cwd, str) or not cwd.startswith("/") or "\x00" in cwd:
            raise GatewayError("Invalid terminal ticket cwd claim")

    return data


def runtime_call(path: str, body: dict) -> dict:
    if not path.startswith("/"):
        raise GatewayError("Invalid runtime path")
    req = urllib.request.Request(
        RUNTIME + path,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "authorization": f"Bearer {RUNTIME_TOKEN}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            payload = json.loads(r.read())
    except urllib.error.HTTPError as exc:
        try:
            err_body = json.loads(exc.read().decode("utf-8", errors="replace"))
            msg = err_body.get("error", {}).get("message", f"Runtime HTTP error {exc.code}")
        except Exception:
            msg = f"Runtime HTTP error {exc.code}"
        raise GatewayError(msg) from exc
    except Exception as exc:
        raise GatewayError(f"Runtime request failed: {exc}") from exc

    if not isinstance(payload, dict) or not payload.get("ok"):
        raise GatewayError(payload.get("error", {}).get("message", "Runtime request failed"))
    return payload["value"]


def ws_accept(key: str) -> str:
    guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
    digest = hashlib.sha1((key.strip() + guid).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("utf-8")


def read_exact(sock: socket.socket, num_bytes: int, timeout: float = 5.0) -> bytes:
    sock.settimeout(timeout)
    chunks = []
    total = 0
    while total < num_bytes:
        try:
            chunk = sock.recv(min(65536, num_bytes - total))
        except (socket.timeout, BlockingIOError):
            break
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def read_frame(sock: socket.socket, max_payload: int = MAX_FRAME_SIZE) -> Tuple[Optional[int], Optional[bytes], bool]:
    """Reads and validates an RFC 6455 WebSocket frame from client.

    Returns (opcode, unmasked_payload, fin).
    If connection closes, returns (None, None, False).
    Raises WebSocketProtocolError on protocol or sizing violations.
    """
    head = read_exact(sock, 2)
    if len(head) < 2:
        return None, None, False

    b1, b2 = head[0], head[1]
    fin = bool(b1 & 0x80)
    rsv = (b1 & 0x70) >> 4
    opcode = b1 & 0x0F

    if rsv != 0:
        raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "RSV bits must be 0")

    valid_opcodes = {OPCODE_CONTINUATION, OPCODE_TEXT, OPCODE_BINARY, OPCODE_CLOSE, OPCODE_PING, OPCODE_PONG}
    if opcode not in valid_opcodes:
        raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, f"Unknown opcode: {opcode}")

    masked = bool(b2 & 0x80)
    # Browser client frames MUST be masked
    if not masked:
        raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "Client frame must be masked")

    n = b2 & 0x7F
    if opcode >= 0x8:
        # Control frames must not be fragmented and length must be <= 125
        if not fin:
            raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "Control frames must not be fragmented")
        if n > 125:
            raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "Control frame payload cannot exceed 125 bytes")

    if n == 126:
        ext = read_exact(sock, 2)
        if len(ext) < 2:
            return None, None, False
        n = struct.unpack("!H", ext)[0]
        if n < 126:
            raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "Payload length not minimally encoded")
    elif n == 127:
        ext = read_exact(sock, 8)
        if len(ext) < 8:
            return None, None, False
        n = struct.unpack("!Q", ext)[0]
        if n < 65536:
            raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "Payload length not minimally encoded")
        if n & 0x8000000000000000:
            raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "64-bit payload length high bit set")

    if n > max_payload:
        raise WebSocketProtocolError(CLOSE_MESSAGE_TOO_BIG, f"Frame payload exceeds limit ({n} > {max_payload})")

    mask = read_exact(sock, 4)
    if len(mask) < 4:
        return None, None, False

    raw = read_exact(sock, n)
    if len(raw) < n:
        return None, None, False

    # Unmask payload
    unmasked = bytearray(raw)
    for i in range(len(unmasked)):
        unmasked[i] ^= mask[i % 4]
    data = bytes(unmasked)

    # Validate close frame payload if opcode == CLOSE
    if opcode == OPCODE_CLOSE:
        if len(data) == 1:
            raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, "Close frame payload of 1 byte is invalid")
        elif len(data) >= 2:
            code = struct.unpack("!H", data[:2])[0]
            if code < 1000 or code > 4999 or code in {1004, 1005, 1006, 1014, 1015, 1016} or (1016 <= code <= 2999):
                raise WebSocketProtocolError(CLOSE_PROTOCOL_ERROR, f"Invalid close code {code}")
            try:
                data[2:].decode("utf-8")
            except UnicodeDecodeError:
                raise WebSocketProtocolError(CLOSE_INVALID_PAYLOAD, "Close frame reason is not valid UTF-8")

    return opcode, data, fin


def recv_frame(sock: socket.socket, max_payload: int = MAX_FRAME_SIZE) -> Tuple[Optional[int], Optional[bytes]]:
    """Legacy helper returning (opcode, payload) for backwards compatibility."""
    opcode, data, _ = read_frame(sock, max_payload)
    return opcode, data


def send_frame(sock: socket.socket, data: bytes, opcode: int = OPCODE_TEXT) -> None:
    """Sends an unmasked RFC 6455 frame from server to client."""
    n = len(data)
    head = bytes([0x80 | (opcode & 0x0F)])
    if n < 126:
        head += bytes([n])
    elif n < 65536:
        head += bytes([126]) + struct.pack("!H", n)
    else:
        head += bytes([127]) + struct.pack("!Q", n)
    sock.sendall(head + data)


def send_close(sock: socket.socket, code: int = CLOSE_NORMAL, reason: str = "") -> None:
    """Sends a clean RFC 6455 close frame."""
    payload = struct.pack("!H", code)
    if reason:
        reason_bytes = reason.encode("utf-8")[:123]
        payload += reason_bytes
    try:
        send_frame(sock, payload, opcode=OPCODE_CLOSE)
    except Exception:
        pass


def client(sock: socket.socket, addr) -> None:
    session = None
    claims = None
    upgraded = False
    acquired_limit = False
    try:
        # 1. Connection limit gate
        if not CONNECTION_LIMITER.acquire():
            try:
                err_resp = (
                    "HTTP/1.1 503 Service Unavailable\r\n"
                    "Content-Type: application/json\r\n"
                    "Connection: close\r\n\r\n"
                    '{"error":"Terminal gateway connection limit reached."}'
                )
                sock.sendall(err_resp.encode("utf-8"))
                try:
                    sock.shutdown(socket.SHUT_WR)
                except Exception:
                    pass
            except Exception:
                pass
            return
        acquired_limit = True

        sock.settimeout(15.0)

        # 2. Read upgrade request headers with bounded size
        request = b""
        while b"\r\n\r\n" not in request:
            if len(request) > MAX_HEADER_SIZE:
                sock.sendall(b"HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n")
                return
            chunk = sock.recv(4096)
            if not chunk:
                return
            request += chunk

        # 3. Parse HTTP upgrade request
        text = request.decode("utf-8", errors="replace")
        lines = text.split("\r\n")
        if not lines or not lines[0]:
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return

        req_parts = lines[0].split()
        if len(req_parts) < 3:
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            return

        method, target, _ = req_parts[0], req_parts[1], req_parts[2]
        if method != "GET":
            sock.sendall(b"HTTP/1.1 405 Method Not Allowed\r\nAllow: GET\r\nConnection: close\r\n\r\n")
            return

        parsed_url = urllib.parse.urlparse(target)
        if parsed_url.path not in ("/v1/terminal", "/"):
            sock.sendall(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n")
            return

        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.lower().strip()] = v.strip()

        if headers.get("upgrade", "").lower() != "websocket":
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nUpgrade: websocket required\r\n")
            return

        conn_hdr = [p.strip().lower() for p in headers.get("connection", "").split(",")]
        if "upgrade" not in conn_hdr:
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nConnection: Upgrade required\r\n")
            return

        ws_version = headers.get("sec-websocket-version", "")
        if ws_version != "13":
            sock.sendall(b"HTTP/1.1 426 Upgrade Required\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\n\r\n")
            return

        ws_key = headers.get("sec-websocket-key", "")
        if not ws_key:
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nSec-WebSocket-Key required\r\n")
            return
        try:
            decoded_key = base64.b64decode(ws_key, validate=True)
            if len(decoded_key) != 16:
                sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid Sec-WebSocket-Key\r\n")
                return
        except Exception:
            sock.sendall(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nInvalid Sec-WebSocket-Key\r\n")
            return

        # Origin check
        if ALLOWED_ORIGIN:
            req_origin = headers.get("origin", "")
            if req_origin != ALLOWED_ORIGIN:
                sock.sendall(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nOrigin denied\r\n")
                return

        # 4. Ticket verification
        params = urllib.parse.parse_qs(parsed_url.query)
        ticket = params.get("ticket", [""])[0]
        if not ticket:
            sock.sendall(b"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nTicket required\r\n")
            return

        try:
            claims = verify_ticket(ticket)
        except GatewayError as exc:
            sock.sendall(f"HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n{str(exc)}\r\n".encode("utf-8"))
            return

        # 5. Send 101 Switching Protocols
        accept_token = ws_accept(ws_key)
        handshake_resp = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_token}\r\n\r\n"
        )
        sock.sendall(handshake_resp.encode("utf-8"))
        upgraded = True

        # 6. Open PTY session in runtime service
        env_id = urllib.parse.quote(claims["environmentId"], safe="")
        open_body = {
            "sessionId": claims["sessionId"],
            "shell": claims.get("shell", "bash"),
            "cwd": claims.get("cwd", "/home/linuxforge"),
            "cols": 120,
            "rows": 30,
            "runtimeLifecycleGeneration": claims.get("runtimeLifecycleGeneration"),
            "bindingGeneration": claims.get("bindingGeneration"),
        }
        opened = runtime_call(f"/v1/environments/{env_id}/pty-open", open_body)
        session = opened["sessionId"]
        send_frame(
            sock,
            json.dumps({"type": "ready", "sessionId": session, "cwd": opened.get("cwd", claims.get("cwd", "/home/linuxforge"))}).encode("utf-8"),
        )

        sock.setblocking(False)
        stop = False
        output_bytes = 0
        session_start = time.monotonic()
        last_activity = time.monotonic()
        base_path = f"/v1/environments/{env_id}"

        # 7. Session message processing loop
        fragment_buffer: Optional[bytearray] = None

        while not stop:
            now = time.monotonic()
            if now - last_activity > IDLE_TIMEOUT:
                send_close(sock, CLOSE_NORMAL, "Session idle timeout")
                break
            if now - session_start > SESSION_TIMEOUT:
                send_close(sock, CLOSE_NORMAL, "Session duration limit reached")
                break

            readable, _, _ = select.select([sock], [], [], 0.08)
            if readable:
                last_activity = time.monotonic()
                sock.setblocking(True)
                try:
                    opcode, frame_data, fin = read_frame(sock, MAX_FRAME_SIZE)
                except WebSocketProtocolError as wse:
                    send_close(sock, wse.code, wse.message)
                    stop = True
                    break
                finally:
                    sock.setblocking(False)

                if opcode is None:
                    # Client closed socket cleanly
                    break

                if opcode == OPCODE_CLOSE:
                    send_close(sock, CLOSE_NORMAL, "")
                    break

                if opcode == OPCODE_PING:
                    send_frame(sock, frame_data or b"", OPCODE_PONG)
                    continue

                if opcode == OPCODE_PONG:
                    continue

                if opcode == OPCODE_BINARY:
                    send_close(sock, CLOSE_UNSUPPORTED_DATA, "Binary frames not supported")
                    stop = True
                    break

                # Frame assembly (text or continuation)
                if opcode == OPCODE_TEXT:
                    if fragment_buffer is not None:
                        send_close(sock, CLOSE_PROTOCOL_ERROR, "Cannot start new message during fragment assembly")
                        stop = True
                        break
                    if fin:
                        msg_bytes = frame_data or b""
                    else:
                        fragment_buffer = bytearray(frame_data or b"")
                        if len(fragment_buffer) > MAX_MESSAGE_SIZE:
                            send_close(sock, CLOSE_MESSAGE_TOO_BIG, "Message size limit exceeded")
                            stop = True
                            break
                        continue
                elif opcode == OPCODE_CONTINUATION:
                    if fragment_buffer is None:
                        send_close(sock, CLOSE_PROTOCOL_ERROR, "Continuation without initial frame")
                        stop = True
                        break
                    fragment_buffer.extend(frame_data or b"")
                    if len(fragment_buffer) > MAX_MESSAGE_SIZE:
                        send_close(sock, CLOSE_MESSAGE_TOO_BIG, "Message size limit exceeded")
                        stop = True
                        break
                    if not fin:
                        continue
                    msg_bytes = bytes(fragment_buffer)
                    fragment_buffer = None
                else:
                    continue

                # Validate assembled text message as UTF-8
                try:
                    text_msg = msg_bytes.decode("utf-8")
                except UnicodeDecodeError:
                    send_close(sock, CLOSE_INVALID_PAYLOAD, "Payload is not valid UTF-8")
                    stop = True
                    break

                # Parse JSON
                try:
                    msg = json.loads(text_msg)
                except json.JSONDecodeError:
                    send_frame(sock, json.dumps({"type": "error", "message": "Malformed JSON message"}).encode("utf-8"))
                    continue

                if not isinstance(msg, dict):
                    send_frame(sock, json.dumps({"type": "error", "message": "Message must be a JSON object"}).encode("utf-8"))
                    continue

                typ = msg.get("type")
                if typ == "input":
                    data_val = msg.get("data")
                    if not isinstance(data_val, str):
                        send_frame(sock, json.dumps({"type": "error", "message": "Input data must be a string"}).encode("utf-8"))
                        continue
                    if len(data_val.encode("utf-8")) > MAX_INPUT_BYTES:
                        send_frame(sock, json.dumps({"type": "error", "message": "Terminal input exceeds maximum allowed length"}).encode("utf-8"))
                        continue
                    runtime_call(base_path + "/pty-input", {"sessionId": session, "data": data_val})

                elif typ == "resize":
                    cols_val = msg.get("cols")
                    rows_val = msg.get("rows")
                    if (
                        not isinstance(cols_val, int)
                        or isinstance(cols_val, bool)
                        or not isinstance(rows_val, int)
                        or isinstance(rows_val, bool)
                    ):
                        send_frame(sock, json.dumps({"type": "error", "message": "Resize dimensions must be integers"}).encode("utf-8"))
                        continue
                    cols_clamped = max(20, min(400, cols_val))
                    rows_clamped = max(5, min(200, rows_val))
                    runtime_call(base_path + "/pty-resize", {"sessionId": session, "cols": cols_clamped, "rows": rows_clamped})

                elif typ == "signal":
                    sig_val = msg.get("signal")
                    if not isinstance(sig_val, str) or sig_val not in SUPPORTED_SIGNALS:
                        send_frame(sock, json.dumps({"type": "error", "message": "Unsupported terminal signal"}).encode("utf-8"))
                        continue
                    runtime_call(base_path + "/pty-signal", {"sessionId": session, "signal": sig_val})

                elif typ == "close":
                    stop = True
                    break

                else:
                    send_frame(sock, json.dumps({"type": "error", "message": f"Unsupported message type: {typ}"}).encode("utf-8"))
                    continue

            # Poll runtime PTY output
            try:
                out = runtime_call(base_path + "/pty-read", {"sessionId": session})
            except Exception:
                break

            if out.get("data"):
                chunk = str(out["data"])
                remaining = MAX_OUTPUT_BYTES - output_bytes
                if remaining <= 0:
                    send_frame(sock, json.dumps({"type": "error", "message": "Terminal output limit reached."}).encode("utf-8"))
                    stop = True
                else:
                    encoded = chunk.encode("utf-8")
                    if len(encoded) > remaining:
                        chunk = encoded[:remaining].decode("utf-8", errors="ignore")
                        stop = True
                    output_bytes += len(chunk.encode("utf-8"))
                    send_frame(sock, json.dumps({"type": "output", "data": chunk}).encode("utf-8"))

            if out.get("exited"):
                send_frame(sock, json.dumps({"type": "exit"}).encode("utf-8"))
                break

    except WebSocketProtocolError as wse:
        if upgraded:
            send_close(sock, wse.code, wse.message)
    except Exception as exc:
        if upgraded:
            try:
                msg = str(exc) if isinstance(exc, GatewayError) else "Terminal session error"
                if RUNTIME_TOKEN and RUNTIME_TOKEN in msg:
                    msg = "Terminal session error"
                send_frame(sock, json.dumps({"type": "error", "message": msg}).encode("utf-8"))
            except Exception:
                pass
    finally:
        if session and claims:
            try:
                runtime_call(f"/v1/environments/{urllib.parse.quote(claims['environmentId'], safe='')}/pty-close", {"sessionId": session})
            except Exception:
                pass
        if acquired_limit:
            CONNECTION_LIMITER.release()
        try:
            sock.close()
        except Exception:
            pass


def main() -> None:
    if not RUNTIME_TOKEN:
        raise SystemExit("FORGE_RUNTIME_SERVICE_TOKEN is required")
    if not TICKET_SECRET:
        raise SystemExit("FORGE_TERMINAL_TICKET_SECRET is required")
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((BIND, PORT))
    srv.listen(128)
    print(f"LinuxForge V49 terminal gateway listening on {BIND}:{PORT}")
    while True:
        sock, addr = srv.accept()
        threading.Thread(target=client, args=(sock, addr), daemon=True).start()


if __name__ == "__main__":
    main()
