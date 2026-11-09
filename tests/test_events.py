from src.api.events import sse_format


class TestSseFormat:
    def test_frame_shape(self):
        frame = sse_format(3, {"event": "token", "text": "hi"})
        assert frame == 'id: 3\nevent: token\ndata: {"event": "token", "text": "hi"}\n\n'

    def test_non_ascii_preserved(self):
        frame = sse_format(0, {"event": "token", "text": "héllo"})
        assert "héllo" in frame
