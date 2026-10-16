"""vision_analyze and video_analyze say when a refused URL's host doesn't resolve.

``is_safe_url`` refuses a host it can't resolve (unless a proxy is configured,
which resolves it instead). vision_analyze then said "blocked: unsafe or
private URL", and video_analyze "Invalid video source. Provide an HTTP/HTTPS
URL or a valid local file path.", even for a typo'd public host.
``unsafe_url_reason`` is the same check and says why it refused, so both now
say "could not resolve <host>" for that case, the way browser_navigate and
web_extract do. Every other refusal keeps its words.

These tests run the real url_safety checks against a fake resolver.
"""

import json
import socket
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from tools import image_source, url_safety, vision_tools

_FAKE_DNS = {
    "acme.dev": "93.184.216.34",
    "intranet.corp": "10.1.2.3",
    "localhost": "127.0.0.1",
}

_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16
_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64

IMAGE_UNRESOLVED = "blocked: could not resolve acme.dve"
IMAGE_PRIVATE = "blocked: unsafe or private URL"
VIDEO_UNRESOLVED = "Blocked: could not resolve acme.dve"
VIDEO_INVALID = "Invalid video source. Provide an HTTP/HTTPS URL or a valid local file path."

_PRIVATE_IMAGE_URLS = [
    "https://intranet.corp/cat.png",
    "http://localhost:8080/cat.png",
    "http://10.0.0.1/cat.png",
    "http://169.254.169.254/latest/meta-data/",
    # refused by name before any lookup, so never "unresolved"
    "http://metadata.google.internal/computeMetadata/v1/",
]
_PRIVATE_VIDEO_URLS = [
    "https://intranet.corp/clip.mp4",
    "http://localhost:8080/clip.mp4",
    "http://10.0.0.1/clip.mp4",
]


def _fake_getaddrinfo(host, port, *args, **kwargs):
    ip = host if host.replace(".", "").isdigit() else _FAKE_DNS.get(host)
    if ip is None:
        raise socket.gaierror(socket.EAI_NONAME, "not in the fake resolver")
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port or 0))]


@pytest.fixture(autouse=True)
def _hermetic_url_checks(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", _fake_getaddrinfo)
    monkeypatch.setenv("AGENTX_ALLOW_PRIVATE_URLS", "false")
    for name in url_safety._PROXY_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    url_safety._reset_allow_private_cache()
    yield
    url_safety._reset_allow_private_cache()


@pytest.fixture
def lookups(monkeypatch):
    """Every host the fake resolver is asked for, in order."""
    asked = []

    def _counting(host, *args, **kwargs):
        asked.append(host)
        return _fake_getaddrinfo(host, *args, **kwargs)

    monkeypatch.setattr(socket, "getaddrinfo", _counting)
    return asked


@pytest.fixture
def image_downloads(monkeypatch):
    """Stub the image download; returns each URL it fetched."""
    fetched = []

    async def _download(url, destination, max_retries=3):
        fetched.append(url)
        destination.write_bytes(_PNG)
        return destination

    monkeypatch.setattr(vision_tools, "_download_image", _download)
    return fetched


@pytest.fixture
def video_downloads(monkeypatch):
    """Stub the video download; returns each URL it fetched."""
    fetched = []

    async def _download(url, destination, max_retries=3):
        fetched.append(url)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(_MP4)
        return destination

    monkeypatch.setattr(vision_tools, "_download_video", _download)
    return fetched


def _llm_answers(text):
    response = MagicMock()
    response.choices = [MagicMock()]
    response.choices[0].message.content = text
    return patch("tools.vision_tools.async_call_llm", new_callable=AsyncMock, return_value=response)


def _resolve(url):
    return image_source.resolve_image_source(url, image_source.ResolveContext())


class TestImageSource:
    def test_says_a_host_does_not_resolve(self):
        assert image_source._http_block_reason("https://acme.dve/cat.png") == IMAGE_UNRESOLVED

    def test_names_the_host_as_parsed(self):
        assert (
            image_source._http_block_reason("https://user@Acme.DVE:8443/cat.png")
            == IMAGE_UNRESOLVED
        )

    @pytest.mark.parametrize("url", _PRIVATE_IMAGE_URLS)
    def test_still_calls_a_private_host_unsafe_or_private(self, url):
        assert image_source._http_block_reason(url) == IMAGE_PRIVATE

    def test_passes_a_public_host(self):
        assert image_source._http_block_reason("https://acme.dev/cat.png") is None

    def test_passes_an_unresolved_host_through_a_proxy(self, monkeypatch):
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")

        assert image_source._http_block_reason("https://acme.dve/cat.png") is None

    def test_looks_a_host_up_again_only_after_a_refusal(self, lookups):
        assert image_source._http_block_reason("https://acme.dev/cat.png") is None
        assert lookups == ["acme.dev"]

        lookups.clear()
        assert image_source._http_block_reason("https://acme.dve/cat.png") == IMAGE_UNRESOLVED
        assert lookups == ["acme.dve", "acme.dve"]

    def test_the_reason_never_lets_a_refused_url_through(self, monkeypatch):
        # The second look finds nothing to blame (say DNS changed in between):
        # still refused, in the old words.
        monkeypatch.setattr(url_safety, "is_safe_url", lambda url: False)

        assert image_source._http_block_reason("https://acme.dev/cat.png") == IMAGE_PRIVATE

    @pytest.mark.asyncio
    async def test_resolver_refuses_before_any_download(self, image_downloads):
        with pytest.raises(image_source.SourceUnsafe) as refused:
            await _resolve("https://acme.dve/cat.png")

        assert str(refused.value) == IMAGE_UNRESOLVED
        assert image_downloads == []

    @pytest.mark.asyncio
    async def test_resolver_downloads_a_public_host(self, image_downloads):
        resolved = await _resolve("https://acme.dev/cat.png")

        assert (resolved.origin, resolved.mime, resolved.data) == ("http", "image/png", _PNG)
        assert image_downloads == ["https://acme.dev/cat.png"]


class TestVisionAnalyze:
    @pytest.mark.asyncio
    async def test_says_a_host_does_not_resolve(self, image_downloads):
        with _llm_answers("A cat") as llm:
            result = json.loads(
                await vision_tools.vision_analyze_tool("https://acme.dve/cat.png", "describe")
            )

        assert result["success"] is False
        assert result["error"] == f"Error analyzing image: {IMAGE_UNRESOLVED}"
        assert result["analysis"].endswith(f"Error: {IMAGE_UNRESOLVED}")
        assert image_downloads == []
        llm.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("url", _PRIVATE_IMAGE_URLS)
    async def test_still_calls_a_private_host_unsafe_or_private(self, image_downloads, url):
        with _llm_answers("A cat") as llm:
            result = json.loads(await vision_tools.vision_analyze_tool(url, "describe"))

        assert result["success"] is False
        assert result["error"] == f"Error analyzing image: {IMAGE_PRIVATE}"
        assert image_downloads == []
        llm.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_analyzes_a_public_host(self, image_downloads):
        with (
            patch(
                "tools.vision_tools._image_to_base64_data_url",
                return_value="data:image/png;base64,abc",
            ),
            _llm_answers("A cat"),
        ):
            result = json.loads(
                await vision_tools.vision_analyze_tool(
                    "https://acme.dev/cat.png", "describe", "test/model"
                )
            )

        assert result == {"success": True, "analysis": "A cat"}
        assert image_downloads == ["https://acme.dev/cat.png"]


class TestVisionAnalyzeNative:
    @pytest.mark.asyncio
    async def test_says_a_host_does_not_resolve(self, image_downloads):
        result = json.loads(
            await vision_tools._vision_analyze_native("https://acme.dve/cat.png", "describe")
        )

        assert result == {"error": IMAGE_UNRESOLVED, "success": False}
        assert image_downloads == []

    @pytest.mark.asyncio
    async def test_still_calls_a_private_host_unsafe_or_private(self, image_downloads):
        result = json.loads(
            await vision_tools._vision_analyze_native("https://intranet.corp/cat.png", "describe")
        )

        assert result == {"error": IMAGE_PRIVATE, "success": False}
        assert image_downloads == []

    @pytest.mark.asyncio
    async def test_loads_a_public_host(self, image_downloads):
        result = await vision_tools._vision_analyze_native("https://acme.dev/cat.png", "describe")

        assert result["_multimodal"] is True, result
        assert image_downloads == ["https://acme.dev/cat.png"]


async def _analyze_video(url):
    return json.loads(await vision_tools.video_analyze_tool(url, "describe"))


class TestVideoAnalyze:
    @pytest.mark.asyncio
    async def test_says_a_host_does_not_resolve(self, video_downloads):
        with _llm_answers("A clip") as llm:
            result = await _analyze_video("https://acme.dve/clip.mp4")

        assert result["success"] is False
        assert result["error"] == f"Error analyzing video: {VIDEO_UNRESOLVED}"
        assert result["analysis"].endswith(f"Error: {VIDEO_UNRESOLVED}")
        assert video_downloads == []
        llm.assert_not_awaited()

    @pytest.mark.asyncio
    @pytest.mark.parametrize("url", _PRIVATE_VIDEO_URLS)
    async def test_still_calls_a_private_host_an_invalid_source(self, video_downloads, url):
        with _llm_answers("A clip") as llm:
            result = await _analyze_video(url)

        assert result["success"] is False
        assert result["error"] == f"Error analyzing video: {VIDEO_INVALID}"
        assert video_downloads == []
        llm.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_analyzes_a_public_host(self, video_downloads):
        with _llm_answers("A clip"), patch(
            "tools.vision_tools.extract_content_or_reasoning", return_value="A clip"
        ):
            result = await _analyze_video("https://acme.dev/clip.mp4")

        assert result == {"success": True, "analysis": "A clip"}
        assert video_downloads == ["https://acme.dev/clip.mp4"]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("source", [
        "/no/such/clip.mp4",
        "ftp://acme.dve/clip.mp4",
        "https://",
    ])
    async def test_what_is_no_http_url_stays_an_invalid_source(self, video_downloads, lookups, source):
        result = await _analyze_video(source)

        assert result["error"] == f"Error analyzing video: {VIDEO_INVALID}"
        assert lookups == []
        assert video_downloads == []

    @pytest.mark.asyncio
    async def test_downloads_an_unresolved_host_through_a_proxy(self, video_downloads, monkeypatch):
        monkeypatch.setenv("HTTPS_PROXY", "http://proxy.test:3128")

        with _llm_answers("A clip"), patch(
            "tools.vision_tools.extract_content_or_reasoning", return_value="A clip"
        ):
            result = await _analyze_video("https://acme.dve/clip.mp4")

        assert result["success"] is True, result
        assert video_downloads == ["https://acme.dve/clip.mp4"]

    @pytest.mark.asyncio
    async def test_looks_a_host_up_again_only_after_a_refusal(self, video_downloads, lookups):
        with _llm_answers("A clip"), patch(
            "tools.vision_tools.extract_content_or_reasoning", return_value="A clip"
        ):
            assert (await _analyze_video("https://acme.dev/clip.mp4"))["success"] is True
        assert lookups == ["acme.dev"]

        lookups.clear()
        assert (await _analyze_video("https://acme.dve/clip.mp4"))["error"] == (
            f"Error analyzing video: {VIDEO_UNRESOLVED}"
        )
        assert lookups == ["acme.dve", "acme.dve"]

    @pytest.mark.asyncio
    async def test_the_reason_never_lets_a_refused_url_through(self, video_downloads, monkeypatch):
        async def _refuse(url):
            return False

        monkeypatch.setattr(vision_tools, "_validate_image_url_async", _refuse)

        result = await _analyze_video("https://acme.dev/clip.mp4")

        assert result["error"] == f"Error analyzing video: {VIDEO_INVALID}"
        assert video_downloads == []
