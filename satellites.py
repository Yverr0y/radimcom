"""SATELLITES tab: the lists of active amateur satellites from amsat.org.

The server downloads the pages (the browser cannot: other origin) and keeps only their content, with an allowlist of
plain tags, so the page can show it directly. The result is cached in data/satellites.json, shared by all VFOs.
Nothing of it is in the package: the lists change often and the content belongs to AMSAT.
"""
import html
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from html.parser import HTMLParser

from paths import data

PAGES = (
    ("linear", "LINEAR", "https://www.amsat.org/live-linear-satellites/"),
    ("fm", "FM", "https://www.amsat.org/live-fm-satellites/"),
    ("image", "IMAGE", "https://www.amsat.org/image-transmitting-satellites/"),
    ("misc", "MISC", "https://www.amsat.org/live-miscellaneous-mode-satellites/"),
)
CACHE_PATH = data("satellites.json")
MAX_AGE_S = 12 * 3600     # older pages are downloaded again when the tab asks for them
MIN_REFRESH_S = 60        # the REFRESH key does not download a page younger than this
TIMEOUT_S = 10
MAX_BYTES = 4_000_000

KEEP = {"p", "br", "strong", "b", "em", "i", "u", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
        "table", "thead", "tbody", "tfoot", "tr", "th", "td"}
DROP_WITH_TEXT = {"script", "style", "noscript", "template"}
URL_IN_TEXT = re.compile(r"(https?://[^\s<>\"']*[^\s<>\"'.,;:!?)\]])")

_lock = threading.Lock()


def _link_open(href):
    return f'<a href="{html.escape(href, quote=True)}" target="_blank" rel="noopener noreferrer">'


class _Content(HTMLParser):
    """Content of <div class="entry-content">, only the tags in KEEP, no attributes except the links we make."""

    def __init__(self, base):
        super().__init__(convert_charrefs=True)
        self.base = base
        self.out = []
        self.divs = 0        # depth of <div> inside the content; 0 = outside it
        self.dropping = 0
        self.links = []      # for each open <a>: did we write it?
        self.p_tag = "p"

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if not self.divs:
            if tag == "div" and "entry-content" in (a.get("class") or "").split():
                self.divs = 1
            return
        if tag == "div":
            self.divs += 1
        elif tag in DROP_WITH_TEXT:
            self.dropping += 1
        elif self.dropping:
            pass
        elif tag == "a":
            href = urllib.parse.urljoin(self.base, (a.get("href") or "").strip())
            # e-mail addresses on the page are hidden by Cloudflare: their name stays as plain text
            ok = href.startswith(("http://", "https://")) and "/cdn-cgi/" not in href
            self.links.append(ok)
            if ok:
                self.out.append(_link_open(href))
        elif tag == "p":
            # the section titles of the page are paragraphs with a large font
            self.p_tag = "h4" if "font-size" in (a.get("style") or "") else "p"
            self.out.append(f"<{self.p_tag}>")
        elif tag in KEEP:
            self.out.append(f"<{tag}>")

    def handle_endtag(self, tag):
        if not self.divs:
            return
        if tag == "div":
            self.divs -= 1
        elif tag in DROP_WITH_TEXT:
            self.dropping = max(0, self.dropping - 1)
        elif self.dropping:
            pass
        elif tag == "a":
            if self.links and self.links.pop():
                self.out.append("</a>")
        elif tag == "p":
            self.out.append(f"</{self.p_tag}>")
        elif tag in KEEP and tag != "br":
            self.out.append(f"</{tag}>")

    def handle_data(self, text):
        if not self.divs or self.dropping:
            return
        if self.links:   # already inside a link
            self.out.append(html.escape(text, quote=False))
            return
        for i, part in enumerate(URL_IN_TEXT.split(text)):   # odd parts = URLs written as plain text
            shown = html.escape(part, quote=False)
            self.out.append(f"{_link_open(part)}{shown}</a>" if i % 2 else shown)


def clean(page, base):
    """Safe HTML with the content of a downloaded page. ValueError if the page has no table (a different page came back)."""
    parser = _Content(base)
    parser.feed(page)
    parser.close()
    out = re.sub(r"<(p|h4)>\s*</\1>", "", "".join(parser.out)).strip()
    if "<table>" not in out:
        raise ValueError("the page has no satellite table")
    return out


def _download(url):
    req = urllib.request.Request(url, headers={"User-Agent": "RADIMCOM"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
        charset = r.headers.get_content_charset() or "utf-8"
        return r.read(MAX_BYTES).decode(charset, "replace")


def _load_cache():
    try:
        with open(CACHE_PATH, encoding="utf-8") as f:
            cache = json.load(f)
        return cache if isinstance(cache, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_cache(cache):
    tmp = f"{CACHE_PATH}.{os.getpid()}.tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, ensure_ascii=False)
        os.replace(tmp, CACHE_PATH)   # each VFO is a separate process
    except OSError as e:              # only the cache is lost
        print(f"satellites: could not save the cache: {e}")


def _fetch(url):
    """(content, error) of one page."""
    try:
        return clean(_download(url), url), None
    except (OSError, ValueError) as e:   # URLError and timeouts are OSError
        return None, str(e)


def load(refresh=False):
    """The pages for the tab: from the cache, the old or missing ones are downloaded first.
    A page that cannot be downloaded keeps its older content and has `error`."""
    with _lock:
        cache = _load_cache()
        now = time.time()
        limit = MIN_REFRESH_S if refresh else MAX_AGE_S
        due = [p for p in PAGES if now - cache.get(p[0], {}).get("fetched", 0) >= limit]
        errors = {}
        if due:
            with ThreadPoolExecutor(len(due)) as pool:
                results = list(pool.map(lambda p: _fetch(p[2]), due))
            for (key, _title, _url), (content, error) in zip(due, results):
                if content is None:
                    errors[key] = error
                else:
                    cache[key] = {"html": content, "fetched": now}
            if len(errors) < len(due):
                _save_cache(cache)
    return {"pages": [{"key": key, "title": title, "url": url, "html": cache.get(key, {}).get("html", ""),
                       "fetched": cache.get(key, {}).get("fetched"), "error": errors.get(key)}
                      for key, title, url in PAGES]}
