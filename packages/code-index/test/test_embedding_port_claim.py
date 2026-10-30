import contextlib
import errno
import io
import os
import socket
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import test_embedding_server  # noqa: F401  installs the fake torch before embedding_server imports
import embedding_http_server
import embedding_server
from embedding_http_handler import EmbeddingHttpHandler
from embedding_http_server import (
    BIND_HOST,
    PORT_IN_USE_EXIT_CODE,
    ThreadedHTTPServer,
    bind_http_server,
)
from embedding_runtime_config import EmbeddingRuntimeConfig


def listening_socket(port: int = 0) -> socket.socket:
    occupant = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    occupant.bind((BIND_HOST, port))
    occupant.listen(1)
    return occupant


def free_port() -> int:
    probe = listening_socket()
    port = probe.getsockname()[1]
    probe.close()
    return port


def assert_port_is_bindable(test: unittest.TestCase, port: int) -> None:
    try:
        listening_socket(port).close()
    except OSError as error:
        test.fail(f"port {port} is still held: {error}")


class EmbeddingPortClaimTest(unittest.TestCase):
    def run_main(self, port: int, server_class: Mock) -> tuple[int | None, str]:
        stderr = io.StringIO()
        exit_code: int | None = None
        with (
            patch.object(sys, "argv", ["embedding_server.py", "--port", str(port)]),
            patch.object(embedding_server, "EmbeddingServer", server_class),
            patch.object(
                embedding_server,
                "load_embedding_runtime_config",
                return_value=EmbeddingRuntimeConfig(),
            ),
            contextlib.redirect_stderr(stderr),
        ):
            try:
                embedding_server.main()
            except SystemExit as error:
                exit_code = error.code
        return exit_code, stderr.getvalue()

    def test_exits_with_the_port_in_use_code_without_loading_the_model(self):
        occupant = listening_socket()
        self.addCleanup(occupant.close)
        port = occupant.getsockname()[1]
        server_class = Mock()
        sentence_transformer = Mock()

        with patch.object(embedding_server, "SentenceTransformer", sentence_transformer):
            exit_code, stderr = self.run_main(port, server_class)

        self.assertEqual(PORT_IN_USE_EXIT_CODE, 98)
        self.assertEqual(exit_code, PORT_IN_USE_EXIT_CODE)
        self.assertEqual(
            stderr,
            f"Embedding server port {BIND_HOST}:{port} is already in use; "
            "exiting without loading the model\n",
        )
        server_class.assert_not_called()
        server_class.return_value.load.assert_not_called()
        sentence_transformer.assert_not_called()

    def test_leaves_the_existing_listener_untouched_when_the_port_is_taken(self):
        occupant = listening_socket()
        self.addCleanup(occupant.close)
        port = occupant.getsockname()[1]

        self.run_main(port, Mock())

        client = socket.create_connection((BIND_HOST, port), timeout=2)
        self.addCleanup(client.close)
        accepted, _ = occupant.accept()
        accepted.close()

    def test_holds_the_port_while_the_model_loads_then_serves_after_loading(self):
        port = free_port()
        events: list[str] = []
        during_load: dict[str, object] = {}
        server = Mock()

        def load():
            events.append("load")
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as duplicate:
                    bind_http_server(port, EmbeddingHttpHandler)
            during_load["duplicate_exit_code"] = duplicate.exception.code
            waiting = socket.create_connection((BIND_HOST, port), timeout=2)
            during_load["backlog_connected"] = True
            waiting.close()

        server.load.side_effect = load
        server_class = Mock(return_value=server)
        configure = Mock(side_effect=lambda *_args: events.append("configure"))
        torch_stub = Mock()

        with (
            patch.object(embedding_server, "configure_http_handler", configure),
            patch.object(embedding_server, "torch", torch_stub),
            patch.object(
                ThreadedHTTPServer,
                "serve_forever",
                lambda _self: events.append("serve"),
            ),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            exit_code, _stderr = self.run_main(port, server_class)

        self.assertIsNone(exit_code)
        self.assertEqual(events, ["load", "configure", "serve"])
        self.assertEqual(during_load["duplicate_exit_code"], PORT_IN_USE_EXIT_CODE)
        self.assertTrue(during_load["backlog_connected"])
        configure.assert_called_once_with(
            server, torch_stub.inference_mode, embedding_server._run_encode_request
        )
        assert_port_is_bindable(self, port)

    def test_closes_the_claimed_port_when_loading_fails(self):
        port = free_port()
        server = Mock()
        server.load.side_effect = RuntimeError("Refusing to load model: not enough memory")
        configure = Mock()
        claimed: list[ThreadedHTTPServer] = []

        def claim_port(claim_port_number, handler_class):
            claimed.append(bind_http_server(claim_port_number, handler_class))
            return claimed[-1]

        with (
            patch.object(embedding_server, "bind_http_server", claim_port),
            patch.object(embedding_server, "configure_http_handler", configure),
            patch.object(sys, "argv", ["embedding_server.py", "--port", str(port)]),
            patch.object(embedding_server, "EmbeddingServer", Mock(return_value=server)),
            patch.object(
                embedding_server,
                "load_embedding_runtime_config",
                return_value=EmbeddingRuntimeConfig(),
            ),
        ):
            with self.assertRaisesRegex(RuntimeError, "not enough memory"):
                embedding_server.main()

        server.load.assert_called_once_with()
        configure.assert_not_called()
        # Holding a reference rules out the socket being closed by garbage collection.
        self.assertEqual(len(claimed), 1)
        self.assertEqual(claimed[0].socket.fileno(), -1)
        assert_port_is_bindable(self, port)

    def test_reports_other_bind_failures_with_the_reason_and_same_exit_code(self):
        denied = OSError(errno.EACCES, "Permission denied")
        stderr = io.StringIO()

        with (
            patch.object(embedding_http_server, "ThreadedHTTPServer", Mock(side_effect=denied)),
            contextlib.redirect_stderr(stderr),
            self.assertRaises(SystemExit) as raised,
        ):
            bind_http_server(80, EmbeddingHttpHandler)

        self.assertEqual(raised.exception.code, PORT_IN_USE_EXIT_CODE)
        self.assertEqual(
            stderr.getvalue(),
            f"Embedding server cannot bind {BIND_HOST}:80 "
            "([Errno 13] Permission denied); exiting without loading the model\n",
        )

    def test_bind_http_server_listens_on_loopback_and_close_frees_the_port(self):
        port = free_port()

        httpd = bind_http_server(port, EmbeddingHttpHandler)
        self.addCleanup(httpd.server_close)

        self.assertEqual(httpd.server_address, (BIND_HOST, port))
        client = socket.create_connection((BIND_HOST, port), timeout=2)
        client.close()
        httpd.server_close()
        assert_port_is_bindable(self, port)


if __name__ == "__main__":
    unittest.main()
