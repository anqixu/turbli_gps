import io
import json
from http import HTTPStatus
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from turbli_gps.server import Handler, TurbliApp


class MockRequest:
    def __init__(self, rfile_content=b""):
        self.rfile = io.BytesIO(rfile_content)
        self.wfile = io.BytesIO()

    def makefile(self, *args, **kwargs):
        return self.rfile


def test_handler_api_state(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        from turbli_gps.server import APP
        # We need to mock the socket and other things BaseHTTPRequestHandler expects
        mock_socket = MagicMock()
        mock_server = MagicMock()
        
        class TestHandler(Handler):
            def __init__(self, *args, **kwargs):
                self.client_address = ("127.0.0.1", 12345)
                self.rfile = io.BytesIO()
                self.wfile = io.BytesIO()
                self.headers = {}
                # Skip BaseHTTPRequestHandler.__init__
                pass

        handler = TestHandler()
        handler.path = "/api/state"
        handler.send_response = MagicMock()
        handler.send_header = MagicMock()
        handler.end_headers = MagicMock()

        handler.do_GET()

        # Check if send_json was called (indirectly via wfile)
        handler.wfile.seek(0)
        response_body = json.loads(handler.wfile.read().decode("utf-8"))
        assert "sources" in response_body
        assert "transforms" in response_body


def test_handler_serve_file_index(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    index_file = static_dir / "index.html"
    index_file.write_text("hello world")

    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        from turbli_gps.server import APP
        APP.static = static_dir
        
        class TestHandler(Handler):
            def __init__(self, *args, **kwargs):
                self.client_address = ("127.0.0.1", 12345)
                self.wfile = io.BytesIO()
                self.headers = {}
                pass

            def send_response(self, code, message=None):
                self.response_code = code
            def send_header(self, keyword, value):
                pass
            def end_headers(self):
                pass

        handler = TestHandler()
        handler.path = "/"
        handler.do_GET()

        assert handler.response_code == HTTPStatus.OK
        handler.wfile.seek(0)
        assert handler.wfile.read() == b"hello world"


def test_handler_serve_file_forbidden(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        class TestHandler(Handler):
            def __init__(self, *args, **kwargs):
                self.client_address = ("127.0.0.1", 12345)
                self.wfile = io.BytesIO()
                pass
            def send_error(self, code, message=None, explain=None):
                self.error_code = code

        handler = TestHandler()
        # Attempt traversal
        handler.path = "/../outside.txt"
        handler.do_GET()
        assert handler.error_code == HTTPStatus.FORBIDDEN


def test_handler_do_post_upload(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        from turbli_gps.server import APP
        
        payload = {"name": "test.png", "dataUrl": "data:image/png;base64,YWJj"} # "abc"
        payload_bytes = json.dumps(payload).encode("utf-8")

        class TestHandler(Handler):
            def __init__(self, rfile_content):
                self.client_address = ("127.0.0.1", 12345)
                self.rfile = io.BytesIO(rfile_content)
                self.wfile = io.BytesIO()
                self.headers = {"Content-Length": str(len(rfile_content))}
                pass
            def send_response(self, code, message=None):
                self.response_code = code
            def send_header(self, keyword, value):
                pass
            def end_headers(self):
                pass

        handler = TestHandler(payload_bytes)
        handler.path = "/api/upload"
        handler.do_POST()

        assert handler.response_code == HTTPStatus.CREATED
        handler.wfile.seek(0)
        response = json.loads(handler.wfile.read().decode("utf-8"))
        assert response["name"] == "test.png"
        assert (APP.storage.uploads_dir / response["url"].split("/")[-1]).exists()


def test_handler_do_post_not_found(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        class TestHandler(Handler):
            def __init__(self, rfile_content):
                self.client_address = ("127.0.0.1", 12345)
                self.rfile = io.BytesIO(rfile_content)
                self.wfile = io.BytesIO()
                self.headers = {"Content-Length": str(len(rfile_content))}
                pass
            def send_response(self, code, message=None):
                self.response_code = code
            def send_header(self, keyword, value):
                pass
            def end_headers(self):
                pass

        handler = TestHandler(b"{}")
        handler.path = "/api/unknown"
        handler.do_POST()
        assert handler.response_code == HTTPStatus.NOT_FOUND


def test_handler_read_json_too_large():
    from turbli_gps.server import MAX_BODY_BYTES
    class TestHandler(Handler):
        def __init__(self):
            self.headers = {"Content-Length": str(MAX_BODY_BYTES + 1)}
            self.wfile = io.BytesIO()
            pass
        def send_response(self, code, message=None):
            self.response_code = code
        def send_header(self, keyword, value):
            pass
        def end_headers(self):
            pass

    handler = TestHandler()
    handler.path = "/api/upload"
    handler.do_POST()
    assert handler.response_code == HTTPStatus.BAD_REQUEST
    handler.wfile.seek(0)
    assert "too large" in handler.wfile.read().decode("utf-8")

def test_handler_do_head(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("content")

    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        class TestHandler(Handler):
            def __init__(self):
                self.wfile = io.BytesIO()
                pass
            def send_response(self, code, message=None):
                self.response_code = code
            def send_header(self, keyword, value):
                pass
            def end_headers(self):
                pass

        handler = TestHandler()
        handler.path = "/index.html"
        handler.do_HEAD()
        assert handler.response_code == HTTPStatus.OK
        assert handler.wfile.getvalue() == b""

def test_handler_log_message():
    class TestHandler(Handler):
        def __init__(self):
            self.client_address = ("1.2.3.4", 12345)
            pass
        def address_string(self):
            return "1.2.3.4"
    handler = TestHandler()
    with patch("builtins.print") as mock_print:
        handler.log_message("test %s", "msg")
        mock_print.assert_called_once_with("1.2.3.4 - test msg")

def test_handler_read_json_empty():
    class TestHandler(Handler):
        def __init__(self):
            self.headers = {}
            pass
    handler = TestHandler()
    assert handler.read_json() == {}

def test_handler_serve_uploads_forbidden(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        class TestHandler(Handler):
            def __init__(self):
                self.wfile = io.BytesIO()
                pass
            def send_error(self, code, message=None, explain=None):
                self.error_code = code
        handler = TestHandler()
        handler.path = "/uploads/../../secret.txt"
        handler.do_GET()
        assert handler.error_code == HTTPStatus.FORBIDDEN

def test_handler_do_post_transform(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        payload = {"sourceId": "test", "transform": {"x": 10}}
        payload_bytes = json.dumps(payload).encode("utf-8")
        class TestHandler(Handler):
            def __init__(self, rfile_content):
                self.rfile = io.BytesIO(rfile_content)
                self.wfile = io.BytesIO()
                self.headers = {"Content-Length": str(len(rfile_content))}
                pass
            def send_response(self, code, message=None):
                self.response_code = code
            def send_header(self, keyword, value):
                pass
            def end_headers(self):
                pass
        handler = TestHandler(payload_bytes)
        handler.path = "/api/transform"
        handler.do_POST()
        assert handler.response_code == HTTPStatus.OK

def test_handler_do_post_turbli_fetch(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        payload = {"latest": True}
        payload_bytes = json.dumps(payload).encode("utf-8")
        class TestHandler(Handler):
            def __init__(self, rfile_content):
                self.rfile = io.BytesIO(rfile_content)
                self.wfile = io.BytesIO()
                self.headers = {"Content-Length": str(len(rfile_content))}
                pass
            def send_response(self, code, message=None):
                self.response_code = code
            def send_header(self, keyword, value):
                pass
            def end_headers(self):
                pass
        handler = TestHandler(payload_bytes)
        handler.path = "/api/turbli/fetch"
        with patch("turbli_gps.server.TurbliApp.fetch_turbli_image", return_value={"id": "x"}):
            handler.do_POST()
        assert handler.response_code == HTTPStatus.CREATED
