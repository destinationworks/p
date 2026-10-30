"""Port claiming for the local embedding server.

The listening socket is bound before the model loads so that a duplicate
launch fails fast instead of loading a multi-gigabyte model first.
"""

import errno
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

PORT_IN_USE_EXIT_CODE = 98
BIND_HOST = "127.0.0.1"


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that already
    # has a live listener, which would defeat the duplicate-server check.
    allow_reuse_address = os.name != "nt"

    def server_close(self):
        try:
            super().server_close()
        except OSError:
            pass  # Ignore "Cannot assign requested address" on close


def bind_http_server(
    port: int, handler_class: type[BaseHTTPRequestHandler]
) -> ThreadedHTTPServer:
    """Bind and listen on the loopback port, or exit with PORT_IN_USE_EXIT_CODE."""
    try:
        return ThreadedHTTPServer((BIND_HOST, port), handler_class)
    except OSError as error:
        address = f"{BIND_HOST}:{port}"
        if error.errno == errno.EADDRINUSE:
            reason = f"Embedding server port {address} is already in use"
        else:
            reason = f"Embedding server cannot bind {address} ({error})"
        print(f"{reason}; exiting without loading the model", file=sys.stderr, flush=True)
        sys.exit(PORT_IN_USE_EXIT_CODE)
