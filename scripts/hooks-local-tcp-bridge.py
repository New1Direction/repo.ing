#!/usr/bin/env python3
"""Transparent local TCP only: Docker refuses published ports on internal networks.

The validator has no egress. This separate dual-network relay exposes only its two
fixed RPC sockets through host-loopback Docker publications. It creates no RPC
responses, interprets no transactions, and has no mounted custody or state.
"""
import selectors
import socket
import socketserver
import threading


class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        with socket.create_connection(('172.29.17.2', self.server.server_address[1]), timeout=10) as upstream:
            upstream.settimeout(None)
            with selectors.DefaultSelector() as ready:
                ready.register(self.request, selectors.EVENT_READ, upstream)
                ready.register(upstream, selectors.EVENT_READ, self.request)
                while True:
                    for key, _ in ready.select():
                        data = key.fileobj.recv(65536)
                        if not data:
                            return
                        key.data.sendall(data)


class Listener(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


servers = [Listener(('0.0.0.0', port), Forward) for port in (18999, 19000)]
for server in servers:
    threading.Thread(target=server.serve_forever, daemon=True).start()
print('LOCAL_VALIDATOR_TCP_BRIDGE_READY', flush=True)
threading.Event().wait()
