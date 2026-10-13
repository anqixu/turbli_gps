import io
import json
from http import HTTPStatus
from unittest.mock import patch

from turbli_gps.server import MAX_BODY_BYTES, Handler, TurbliApp


class FakeHandler(Handler):
    """Handler without a socket: records the status and buffers the body."""

    def __init__(self, path: str, body: bytes = b""):
        self.path = path
        self.client_address = ("127.0.0.1", 12345)
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.headers = {"Content-Length": str(len(body))} if body else {}
        self.status = None

    def send_response(self, code, message=None):
        self.status = code

    def send_error(self, code, message=None, explain=None):
        self.status = code

    def send_header(self, keyword, value):
        pass

    def end_headers(self):
        pass

    def json(self) -> dict:
        return json.loads(self.wfile.getvalue().decode("utf-8"))


def post(path: str, payload: dict) -> FakeHandler:
    handler = FakeHandler(path, json.dumps(payload).encode("utf-8"))
    handler.do_POST()
    return handler


def test_handler_api_state(tmp_path):
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        handler = FakeHandler("/api/state")
        handler.do_GET()
    assert {"sources", "transforms"} <= handler.json().keys()


def test_handler_serves_static_files_and_heads(tmp_path):
    static_dir = tmp_path / "static"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("hello world")
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        handler = FakeHandler("/")
        handler.do_GET()
        assert handler.status == HTTPStatus.OK
        assert handler.wfile.getvalue() == b"hello world"

        handler = FakeHandler("/index.html")
        handler.do_HEAD()
        assert handler.status == HTTPStatus.OK
        assert handler.wfile.getvalue() == b""


def test_handler_serve_file_forbidden(tmp_path):
    (tmp_path / "static").mkdir()
    # A sibling directory shares the "static" string prefix.
    sibling = tmp_path / "static_evil"
    sibling.mkdir()
    (sibling / "secret.txt").write_text("secret")
    with patch("turbli_gps.server.APP", TurbliApp(tmp_path)):
        for path in ("/../outside.txt", "/../static_evil/secret.txt", "/uploads/../../secret.txt"):
            handler = FakeHandler(path)
            handler.do_GET()
            assert handler.status == HTTPStatus.FORBIDDEN, path


def test_handler_post_routes(tmp_path):
    app = TurbliApp(tmp_path)
    with patch("turbli_gps.server.APP", app):
        upload = post("/api/upload", {"name": "test.png", "dataUrl": "data:image/png;base64,YWJj"})
        assert upload.status == HTTPStatus.CREATED
        assert upload.json()["name"] == "test.png"
        assert (app.storage.uploads_dir / upload.json()["url"].split("/")[-1]).exists()

        assert post("/api/transform", {"sourceId": "test", "transform": {"x": 10}}).status == HTTPStatus.OK
        assert post("/api/unknown", {}).status == HTTPStatus.NOT_FOUND
        with patch.object(app, "fetch_turbli_image", return_value={"id": "x"}):
            assert post("/api/turbli/fetch", {"latest": True}).status == HTTPStatus.CREATED


def test_handler_read_json_limits():
    assert FakeHandler("/api/upload").read_json() == {}

    handler = FakeHandler("/api/upload")
    handler.headers = {"Content-Length": str(MAX_BODY_BYTES + 1)}
    handler.do_POST()
    assert handler.status == HTTPStatus.BAD_REQUEST
    assert "too large" in handler.json()["error"]


def test_handler_log_message():
    handler = FakeHandler("/")
    with patch("turbli_gps.server.logger") as mock_logger:
        handler.log_message("test %s", "msg")
    mock_logger.info.assert_called_once_with("%s - %s", "127.0.0.1", "test msg")
