import base64
import hashlib
import hmac
import importlib.util
import json
import os
import socket
import struct
import sys
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "runtime" / "terminal-gateway.py"
spec = importlib.util.spec_from_file_location("linuxforge_terminal_gateway", MODULE_PATH)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def make_client_frame(
    opcode: int,
    payload: bytes,
    fin: bool = True,
    rsv: int = 0,
    mask_key: bytes = b"\x12\x34\x56\x78",
) -> bytes:
    """Encodes a masked RFC 6455 client-to-server frame."""
    b0 = (0x80 if fin else 0) | ((rsv & 0x07) << 4) | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        b1 = 0x80 | n
        len_bytes = b""
    elif n < 65536:
        b1 = 0x80 | 126
        len_bytes = struct.pack("!H", n)
    else:
        b1 = 0x80 | 127
        len_bytes = struct.pack("!Q", n)
    masked = bytearray(payload)
    for i in range(len(masked)):
        masked[i] ^= mask_key[i % 4]
    return bytes([b0, b1]) + len_bytes + mask_key + bytes(masked)


def make_unmasked_frame(opcode: int, payload: bytes, fin: bool = True, rsv: int = 0) -> bytes:
    """Encodes an unmasked frame (protocol violation when sent by client)."""
    b0 = (0x80 if fin else 0) | ((rsv & 0x07) << 4) | (opcode & 0x0F)
    n = len(payload)
    if n < 126:
        b1 = n
        len_bytes = b""
    elif n < 65536:
        b1 = 126
        len_bytes = struct.pack("!H", n)
    else:
        b1 = 127
        len_bytes = struct.pack("!Q", n)
    return bytes([b0, b1]) + len_bytes + payload


def read_server_frame(sock: socket.socket) -> tuple[int, bytes]:
    """Reads an unmasked server-to-client frame."""
    head = sock.recv(2)
    if len(head) < 2:
        return -1, b""
    b0, b1 = head[0], head[1]
    opcode = b0 & 0x0F
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack("!H", sock.recv(2))[0]
    elif n == 127:
        n = struct.unpack("!Q", sock.recv(8))[0]
    data = b""
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            break
        data += chunk
    return opcode, data


class TerminalGatewayTests(unittest.TestCase):
    def setUp(self):
        self.old_secret = os.environ.get("FORGE_TERMINAL_TICKET_SECRET")
        self.old_origin = module.ALLOWED_ORIGIN
        self.old_max_conns = module.CONNECTION_LIMITER.max_connections
        os.environ["FORGE_TERMINAL_TICKET_SECRET"] = "v49-test-secret-that-is-at-least-32-bytes-long"
        module.TICKET_SECRET = os.environ["FORGE_TERMINAL_TICKET_SECRET"].encode()
        module.ALLOWED_ORIGIN = ""
        module.RUNTIME_TOKEN = "test-runtime-token"

    def tearDown(self):
        if self.old_secret is None:
            os.environ.pop("FORGE_TERMINAL_TICKET_SECRET", None)
        else:
            os.environ["FORGE_TERMINAL_TICKET_SECRET"] = self.old_secret
        module.ALLOWED_ORIGIN = self.old_origin
        module.CONNECTION_LIMITER.max_connections = self.old_max_conns
        # Drain active connection count
        while module.CONNECTION_LIMITER.count > 0:
            module.CONNECTION_LIMITER.release()

    def make_ticket(
        self,
        user_id: str = "u1",
        lab_id: str = "l1",
        env_id: str = "e1",
        session_id: str = "s1",
        binding_gen: int = 2,
        runtime_gen: int = 7,
        exp_offset: int = 60,
    ) -> str:
        claims = {
            "userId": user_id,
            "labId": lab_id,
            "environmentId": env_id,
            "sessionId": session_id,
            "bindingGeneration": binding_gen,
            "runtimeLifecycleGeneration": runtime_gen,
            "exp": time.time() + exp_offset,
        }
        payload = module.b64u(json.dumps(claims).encode("utf-8"))
        sig = module.b64u(hmac.new(module.TICKET_SECRET, payload.encode("utf-8"), hashlib.sha256).digest())
        return payload + "." + sig

    # 1. Ticket validation tests
    def test_ticket_verification_is_scoped(self):
        ticket = self.make_ticket(env_id="e-production-1")
        claims = module.verify_ticket(ticket)
        self.assertEqual(claims["environmentId"], "e-production-1")
        self.assertEqual(claims["bindingGeneration"], 2)
        self.assertEqual(claims["runtimeLifecycleGeneration"], 7)

    def test_tampering_is_rejected(self):
        with self.assertRaises(module.GatewayError):
            module.verify_ticket("bad.bad")

    def test_expired_ticket_is_rejected(self):
        ticket = self.make_ticket(exp_offset=-10)
        with self.assertRaises(module.GatewayError) as ctx:
            module.verify_ticket(ticket)
        self.assertIn("expired", str(ctx.exception).lower())

    def test_missing_required_claims_rejected(self):
        for missing in ("userId", "labId", "environmentId", "sessionId"):
            claims = {
                "userId": "u",
                "labId": "l",
                "environmentId": "e",
                "sessionId": "s",
                "bindingGeneration": 1,
                "runtimeLifecycleGeneration": 1,
                "exp": time.time() + 60,
            }
            del claims[missing]
            payload = module.b64u(json.dumps(claims).encode("utf-8"))
            sig = module.b64u(hmac.new(module.TICKET_SECRET, payload.encode("utf-8"), hashlib.sha256).digest())
            with self.assertRaises(module.GatewayError):
                module.verify_ticket(payload + "." + sig)

    def test_bad_generation_claims_rejected(self):
        for bad_gen in (0, -1, "2", 1.5, True):
            claims = {
                "userId": "u",
                "labId": "l",
                "environmentId": "e",
                "sessionId": "s",
                "bindingGeneration": bad_gen,
                "runtimeLifecycleGeneration": 1,
                "exp": time.time() + 60,
            }
            payload = module.b64u(json.dumps(claims).encode("utf-8"))
            sig = module.b64u(hmac.new(module.TICKET_SECRET, payload.encode("utf-8"), hashlib.sha256).digest())
            with self.assertRaises(module.GatewayError):
                module.verify_ticket(payload + "." + sig)

    def test_unsafe_id_claims_rejected(self):
        ticket = self.make_ticket(env_id="../../etc/shadow")
        with self.assertRaises(module.GatewayError):
            module.verify_ticket(ticket)

    # 2. WebSocket frame parsing & validation tests
    def test_masked_vs_unmasked_client_frames(self):
        server_sock, client_sock = socket.socketpair()
        try:
            # Masked frame should succeed
            client_sock.sendall(make_client_frame(module.OPCODE_TEXT, b'{"type":"ping"}'))
            opcode, data, fin = module.read_frame(server_sock)
            self.assertEqual(opcode, module.OPCODE_TEXT)
            self.assertEqual(data, b'{"type":"ping"}')
            self.assertTrue(fin)

            # Unmasked frame must be rejected with CLOSE_PROTOCOL_ERROR (1002)
            client_sock.sendall(make_unmasked_frame(module.OPCODE_TEXT, b'{"type":"ping"}'))
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock)
            self.assertEqual(ctx.exception.code, module.CLOSE_PROTOCOL_ERROR)
        finally:
            server_sock.close()
            client_sock.close()

    def test_oversized_frame_rejected(self):
        server_sock, client_sock = socket.socketpair()
        try:
            # Frame claiming 20000 bytes with limit 16384
            head = bytes([0x81, 0x80 | 126]) + struct.pack("!H", 20000) + b"\x00\x00\x00\x00"
            client_sock.sendall(head)
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock, max_payload=16384)
            self.assertEqual(ctx.exception.code, module.CLOSE_MESSAGE_TOO_BIG)
        finally:
            server_sock.close()
            client_sock.close()

    def test_rsv_bits_must_be_zero(self):
        server_sock, client_sock = socket.socketpair()
        try:
            # RSV1 bit set (rsv = 4)
            client_sock.sendall(make_client_frame(module.OPCODE_TEXT, b"test", rsv=4))
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock)
            self.assertEqual(ctx.exception.code, module.CLOSE_PROTOCOL_ERROR)
        finally:
            server_sock.close()
            client_sock.close()

    def test_invalid_control_frame_fragmented(self):
        server_sock, client_sock = socket.socketpair()
        try:
            # FIN = 0 for a Ping (opcode 9)
            client_sock.sendall(make_client_frame(module.OPCODE_PING, b"ping", fin=False))
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock)
            self.assertEqual(ctx.exception.code, module.CLOSE_PROTOCOL_ERROR)
        finally:
            server_sock.close()
            client_sock.close()

    def test_invalid_control_frame_oversized(self):
        server_sock, client_sock = socket.socketpair()
        try:
            # Control frame payload > 125 bytes
            oversized_payload = b"a" * 126
            client_sock.sendall(make_client_frame(module.OPCODE_PING, oversized_payload))
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock)
            self.assertEqual(ctx.exception.code, module.CLOSE_PROTOCOL_ERROR)
        finally:
            server_sock.close()
            client_sock.close()

    def test_malformed_close_frame_rejected(self):
        server_sock, client_sock = socket.socketpair()
        try:
            # 1-byte payload is invalid in close frame
            client_sock.sendall(make_client_frame(module.OPCODE_CLOSE, b"\x03"))
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock)
            self.assertEqual(ctx.exception.code, module.CLOSE_PROTOCOL_ERROR)

            # Invalid close code 1005 (reserved for internal use)
            client_sock.sendall(make_client_frame(module.OPCODE_CLOSE, struct.pack("!H", 1005)))
            with self.assertRaises(module.WebSocketProtocolError) as ctx:
                module.read_frame(server_sock)
            self.assertEqual(ctx.exception.code, module.CLOSE_PROTOCOL_ERROR)
        finally:
            server_sock.close()
            client_sock.close()

    # 3. HTTP Upgrade Handshake Validation Tests
    def test_upgrade_rejection_for_bad_method(self):
        server_sock, client_sock = socket.socketpair()
        t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
        t.start()
        try:
            client_sock.sendall(b"POST /v1/terminal HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            resp = client_sock.recv(1024).decode("utf-8", errors="replace")
            self.assertIn("405 Method Not Allowed", resp)
        finally:
            client_sock.close()
            t.join(timeout=2.0)

    def test_upgrade_rejection_for_missing_key(self):
        server_sock, client_sock = socket.socketpair()
        t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
        t.start()
        try:
            req = (
                "GET /v1/terminal HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            )
            client_sock.sendall(req.encode("utf-8"))
            resp = client_sock.recv(1024).decode("utf-8", errors="replace")
            self.assertIn("400 Bad Request", resp)
            self.assertIn("Sec-WebSocket-Key required", resp)
        finally:
            client_sock.close()
            t.join(timeout=2.0)

    def test_upgrade_rejection_for_bad_version(self):
        server_sock, client_sock = socket.socketpair()
        t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
        t.start()
        try:
            req = (
                "GET /v1/terminal HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Version: 8\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            )
            client_sock.sendall(req.encode("utf-8"))
            resp = client_sock.recv(1024).decode("utf-8", errors="replace")
            self.assertIn("426 Upgrade Required", resp)
            self.assertIn("Sec-WebSocket-Version: 13", resp)
        finally:
            client_sock.close()
            t.join(timeout=2.0)

    def test_upgrade_rejection_for_bad_origin(self):
        module.ALLOWED_ORIGIN = "https://app.linuxforge.dev"
        server_sock, client_sock = socket.socketpair()
        t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
        t.start()
        try:
            req = (
                "GET /v1/terminal HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
                "Origin: https://evil.attacker.com\r\n\r\n"
            )
            client_sock.sendall(req.encode("utf-8"))
            resp = client_sock.recv(1024).decode("utf-8", errors="replace")
            self.assertIn("403 Forbidden", resp)
        finally:
            client_sock.close()
            t.join(timeout=2.0)

    def test_upgrade_rejection_for_oversized_headers(self):
        server_sock, client_sock = socket.socketpair()
        t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
        t.start()
        try:
            # Over 8192 bytes of headers without termination
            junk = "X-Junk: " + ("A" * 1000) + "\r\n"
            oversized_req = ("GET /v1/terminal HTTP/1.1\r\n" + (junk * 10)).encode("utf-8")
            client_sock.sendall(oversized_req)
            resp = client_sock.recv(1024).decode("utf-8", errors="replace")
            self.assertIn("431 Request Header Fields Too Large", resp)
        finally:
            client_sock.close()
            t.join(timeout=2.0)

    # 4. Connection Concurrency Limit Test
    def test_connection_concurrency_limit(self):
        module.CONNECTION_LIMITER.max_connections = 1
        self.assertTrue(module.CONNECTION_LIMITER.acquire())  # 1 connection active now

        server_sock, client_sock = socket.socketpair()
        t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
        t.start()
        try:
            ticket = self.make_ticket()
            req = (
                f"GET /v1/terminal?ticket={ticket} HTTP/1.1\r\n"
                "Host: 127.0.0.1\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Version: 13\r\n"
                "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
            )
            client_sock.sendall(req.encode("utf-8"))
            resp = client_sock.recv(1024).decode("utf-8", errors="replace")
            self.assertIn("503 Service Unavailable", resp)
            self.assertIn("connection limit reached", resp)
        finally:
            client_sock.close()
            t.join(timeout=2.0)
            module.CONNECTION_LIMITER.release()

    # 5. End-to-end Terminal Flow & Message Validation Tests
    def test_valid_terminal_flow_with_input_resize_signal_and_close(self):
        ticket = self.make_ticket(env_id="env-e2e", session_id="sess-e2e")
        server_sock, client_sock = socket.socketpair()

        runtime_calls = []

        def mock_runtime_call(path: str, body: dict) -> dict:
            runtime_calls.append((path, body))
            if path.endswith("/pty-open"):
                return {"sessionId": "sess-e2e", "cwd": "/home/linuxforge"}
            elif path.endswith("/pty-input"):
                return {"accepted": True}
            elif path.endswith("/pty-resize"):
                return {"cols": body.get("cols", 120), "rows": body.get("rows", 30)}
            elif path.endswith("/pty-signal"):
                return {"accepted": True, "signal": body.get("signal")}
            elif path.endswith("/pty-read"):
                return {"sessionId": "sess-e2e", "data": "linuxforge$ "}
            elif path.endswith("/pty-close"):
                return {"closed": True}
            return {}

        with mock.patch.object(module, "runtime_call", side_effect=mock_runtime_call):
            t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
            t.start()
            try:
                # 1. Send handshake
                req = (
                    f"GET /v1/terminal?ticket={ticket} HTTP/1.1\r\n"
                    "Host: 127.0.0.1\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Version: 13\r\n"
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                )
                client_sock.sendall(req.encode("utf-8"))

                # Read HTTP response headers
                resp = b""
                while b"\r\n\r\n" not in resp:
                    resp += client_sock.recv(1024)
                self.assertIn(b"101 Switching Protocols", resp)
                self.assertIn(b"Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=", resp)

                # 2. Read initial ready frame
                opcode, ready_bytes = read_server_frame(client_sock)
                self.assertEqual(opcode, module.OPCODE_TEXT)
                ready_msg = json.loads(ready_bytes.decode("utf-8"))
                self.assertEqual(ready_msg["type"], "ready")
                self.assertEqual(ready_msg["sessionId"], "sess-e2e")

                # 3. Read output frame from pty-read
                opcode, out_bytes = read_server_frame(client_sock)
                self.assertEqual(opcode, module.OPCODE_TEXT)
                out_msg = json.loads(out_bytes.decode("utf-8"))
                self.assertEqual(out_msg["type"], "output")
                self.assertEqual(out_msg["data"], "linuxforge$ ")

                # 4. Send valid input message
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "input", "data": "whoami\n"}).encode("utf-8")))
                time.sleep(0.05)

                # 5. Send resize message
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "resize", "cols": 100, "rows": 40}).encode("utf-8")))
                time.sleep(0.05)

                # 6. Send signal message
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "signal", "signal": "SIGINT"}).encode("utf-8")))
                time.sleep(0.05)

                # 7. Send close message
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "close"}).encode("utf-8")))

            finally:
                client_sock.close()
                t.join(timeout=2.0)

        # Verify runtime calls occurred in correct order with verified environmentId
        call_paths = [p for p, _ in runtime_calls]
        self.assertIn("/v1/environments/env-e2e/pty-open", call_paths)
        self.assertIn("/v1/environments/env-e2e/pty-input", call_paths)
        self.assertIn("/v1/environments/env-e2e/pty-resize", call_paths)
        self.assertIn("/v1/environments/env-e2e/pty-signal", call_paths)
        self.assertIn("/v1/environments/env-e2e/pty-close", call_paths)

        # Verify pty-open body bound claims
        open_call = next(b for p, b in runtime_calls if p.endswith("/pty-open"))
        self.assertEqual(open_call["sessionId"], "sess-e2e")
        self.assertEqual(open_call["bindingGeneration"], 2)
        self.assertEqual(open_call["runtimeLifecycleGeneration"], 7)

    def test_fragmented_text_frame_assembly(self):
        ticket = self.make_ticket(env_id="env-frag")
        server_sock, client_sock = socket.socketpair()
        received_inputs = []

        def mock_runtime_call(path: str, body: dict) -> dict:
            if path.endswith("/pty-open"):
                return {"sessionId": "s-frag", "cwd": "/home/linuxforge"}
            elif path.endswith("/pty-input"):
                received_inputs.append(body.get("data"))
                return {"accepted": True}
            elif path.endswith("/pty-read"):
                return {"sessionId": "s-frag", "data": ""}
            elif path.endswith("/pty-close"):
                return {"closed": True}
            return {}

        with mock.patch.object(module, "runtime_call", side_effect=mock_runtime_call):
            t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
            t.start()
            try:
                # Handshake
                req = (
                    f"GET /v1/terminal?ticket={ticket} HTTP/1.1\r\n"
                    "Host: 127.0.0.1\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Version: 13\r\n"
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                )
                client_sock.sendall(req.encode("utf-8"))
                resp = b""
                while b"\r\n\r\n" not in resp:
                    resp += client_sock.recv(1024)

                # Discard ready frame
                read_server_frame(client_sock)

                # Send fragmented JSON:
                # Fragment 1: FIN=0, opcode=TEXT, data='{"type":"input","da'
                part1 = b'{"type":"input","da'
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, part1, fin=False))

                # Fragment 2: FIN=1, opcode=CONTINUATION, data='ta":"echo ok\\n"}'
                part2 = b'ta":"echo ok\\n"}'
                client_sock.sendall(make_client_frame(module.OPCODE_CONTINUATION, part2, fin=True))

                time.sleep(0.1)
                self.assertIn("echo ok\n", received_inputs)

                # Close cleanly
                client_sock.sendall(make_client_frame(module.OPCODE_CLOSE, struct.pack("!H", 1000)))
            finally:
                client_sock.close()
                t.join(timeout=2.0)

    def test_invalid_terminal_inputs_send_error_frames(self):
        ticket = self.make_ticket(env_id="env-errs")
        server_sock, client_sock = socket.socketpair()

        def mock_runtime_call(path: str, body: dict) -> dict:
            if path.endswith("/pty-open"):
                return {"sessionId": "s-errs", "cwd": "/home/linuxforge"}
            elif path.endswith("/pty-read"):
                return {"sessionId": "s-errs", "data": ""}
            elif path.endswith("/pty-close"):
                return {"closed": True}
            return {}

        with mock.patch.object(module, "runtime_call", side_effect=mock_runtime_call):
            t = threading.Thread(target=module.client, args=(server_sock, ("127.0.0.1", 12345)), daemon=True)
            t.start()
            try:
                # Handshake
                req = (
                    f"GET /v1/terminal?ticket={ticket} HTTP/1.1\r\n"
                    "Host: 127.0.0.1\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    "Sec-WebSocket-Version: 13\r\n"
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
                )
                client_sock.sendall(req.encode("utf-8"))
                resp = b""
                while b"\r\n\r\n" not in resp:
                    resp += client_sock.recv(1024)

                # Discard ready frame
                read_server_frame(client_sock)

                # Test 1: Malformed JSON
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, b"{not valid json"))
                _, err_bytes = read_server_frame(client_sock)
                err_msg = json.loads(err_bytes.decode("utf-8"))
                self.assertEqual(err_msg["type"], "error")
                self.assertIn("Malformed JSON", err_msg["message"])

                # Test 2: Non-string input data
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "input", "data": 12345}).encode("utf-8")))
                _, err_bytes = read_server_frame(client_sock)
                err_msg = json.loads(err_bytes.decode("utf-8"))
                self.assertEqual(err_msg["type"], "error")
                self.assertIn("must be a string", err_msg["message"])

                # Test 3: Non-integer resize
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "resize", "cols": "100", "rows": 30}).encode("utf-8")))
                _, err_bytes = read_server_frame(client_sock)
                err_msg = json.loads(err_bytes.decode("utf-8"))
                self.assertEqual(err_msg["type"], "error")
                self.assertIn("must be integers", err_msg["message"])

                # Test 4: Unsupported signal
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "signal", "signal": "SIGKILL"}).encode("utf-8")))
                _, err_bytes = read_server_frame(client_sock)
                err_msg = json.loads(err_bytes.decode("utf-8"))
                self.assertEqual(err_msg["type"], "error")
                self.assertIn("Unsupported terminal signal", err_msg["message"])

                # Test 5: Unknown message type
                client_sock.sendall(make_client_frame(module.OPCODE_TEXT, json.dumps({"type": "arbitrary_cmd"}).encode("utf-8")))
                _, err_bytes = read_server_frame(client_sock)
                err_msg = json.loads(err_bytes.decode("utf-8"))
                self.assertEqual(err_msg["type"], "error")
                self.assertIn("Unsupported message type", err_msg["message"])

                # Close cleanly
                client_sock.sendall(make_client_frame(module.OPCODE_CLOSE, struct.pack("!H", 1000)))
            finally:
                client_sock.close()
                t.join(timeout=2.0)


if __name__ == "__main__":
    unittest.main()
