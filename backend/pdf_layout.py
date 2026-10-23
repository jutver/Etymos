"""
pdf_layout.py
-------------
Page-level layout analysis behind extractor.py's PDF extraction.

PyMuPDF reports text as blocks → lines → spans with positions. Reading
only the text (as extractor.py used to) loses what the layout says about
it, which is why the Document view used to show:

- the logo and the running header ("3 Dataset and ...", "Project Final
  Report 2") printed on every page, mixed into the content;
- the table of contents read as real headings;
- heading numbers split from their titles ("3.1" and "Dataset" are two
  PyMuPDF lines on the same row);
- tables as runs of loose words, and figures drawn as vector paths lost.

`analyze_pdf()` reads every page once and returns the content lines in
reading order with that noise removed, plus the tables and figures found
on the pages, each with the position needed to put it back in the flow.
It never raises for a damaged page or figure: those are skipped, the same
"best effort, never break text extraction" rule the old image extraction
followed.
"""

from __future__ import annotations

import logging
import re
from collections import Counter, defaultdict

import fitz

logger = logging.getLogger(__name__)

# A page counts as rotated (a landscape table set sideways on a portrait
# page) when most of its characters run vertically.
ROTATED_PAGE_SHARE = 0.6
# Running headers/footers are looked for in this share of the page height.
FURNITURE_REGION = 0.16
# A header/footer row is at most this many words.
FURNITURE_MAX_WORDS = 12
# An image on this many pages (or this share of them) is a logo or
# decoration, not a figure.
REPEATED_IMAGE_MIN_PAGES = 3
REPEATED_IMAGE_PAGE_SHARE = 0.4
# Figures smaller than this share of the page are icons or bullets.
MIN_FIGURE_AREA_SHARE = 0.02
# A raster image covering more than this share of the page is a page
# background (slides, certificates), not a figure.
BACKGROUND_AREA_SHARE = 0.6
# Figure snapshots are rendered at this resolution, capped in pixels.
SNAPSHOT_DPI = 150
SNAPSHOT_MAX_PIXELS = 2200

TABLE_CAPTION_RE = re.compile(
    r"^(?:table|tab\.|bảng)\s+(?:\d+|[ivxlc]+)(?:\.\d+)?\s*(?:[:.|—–-]|$)", re.IGNORECASE
)
FIGURE_CAPTION_RE = re.compile(
    r"^(?:figure|fig\.|hình|hinh)\s+\d+(?:\.\d+)?\s*(?:[:.|—–-]|$)", re.IGNORECASE
)
TOC_TITLES = {
    "contents", "table of contents", "table of content", "mục lục", "muc luc",
    "list of figures", "list of tables", "danh mục hình", "danh mục bảng",
    "danh mục hình ảnh", "danh mục bảng biểu",
}
PAGE_NUMBER_RE = re.compile(r"^(?:page\s*)?\d{1,4}(?:\s*(?:/|of)\s*\d{1,4})?$", re.IGNORECASE)
TOC_LEADER_RE = re.compile(r"(?:\.\s*){3,}\s*(?:\d{1,4}|[ivxlc]{1,6})$|…+\s*(?:\d{1,4}|[ivxlc]{1,6})$", re.IGNORECASE)
TOC_NUMBER_RE = re.compile(r"^(?:\d{1,4}|[ivxlc]{1,6})$", re.IGNORECASE)
TERMINAL_PUNCTUATION = (".", "!", "?", ":", ";", "”", '"', ")", "]")


# --- Reading lines -----------------------------------------------------------

def _line_text(spans):
    return " ".join(s["text"].strip() for s in spans if s["text"].strip()).strip()


def _is_horizontal(direction):
    return abs(direction[0] - 1) < 0.05 and abs(direction[1]) < 0.05


def dominant_rotation(page_dict):
    """0 for an upright page; otherwise the `show_pdf_page(rotate=...)`
    angle that turns the page's (mostly vertical) text upright."""
    counts = Counter()
    for block in page_dict.get("blocks", []):
        for line in block.get("lines", []):
            chars = sum(len(s.get("text", "").strip()) for s in line.get("spans", []))
            if not chars:
                continue
            dx, dy = line.get("dir", (1, 0))
            if abs(dx) >= abs(dy):
                counts["horizontal"] += chars
            elif dy < 0:
                counts["up"] += chars
            else:
                counts["down"] += chars
    total = sum(counts.values())
    if total < 50:
        return 0
    if counts["up"] / total > ROTATED_PAGE_SHARE:
        return -90
    if counts["down"] / total > ROTATED_PAGE_SHARE:
        return 90
    return 0


def _page_lines(page_dict, page_number):
    """Horizontal text lines of one page, with fragments on the same row of
    the same PyMuPDF block joined ("3.1" + "Dataset" -> "3.1 Dataset").
    Lines running in any other direction (an arXiv side stamp) are dropped:
    on an upright page they are never body text."""
    lines = []
    for block_no, block in enumerate(page_dict.get("blocks", [])):
        if block.get("type") != 0:
            continue
        block_id = f"{page_number}:{block_no}"
        merged = []
        for raw in block.get("lines", []):
            if not _is_horizontal(raw.get("dir", (1, 0))):
                continue
            spans = [s for s in raw.get("spans", []) if s.get("text", "").strip()]
            if not spans:
                continue
            bbox = list(raw["bbox"])
            size = max(s.get("size", 0) for s in spans)
            previous = merged[-1] if merged else None
            if previous is not None:
                height = min(bbox[3] - bbox[1], previous["bbox"][3] - previous["bbox"][1]) or size
                same_row = abs((bbox[1] + bbox[3]) / 2 - (previous["bbox"][1] + previous["bbox"][3]) / 2) < 0.5 * height
                gap = bbox[0] - previous["bbox"][2]
                if same_row and -1 <= gap < 3 * max(size, previous["size"]):
                    previous["spans"].extend(spans)
                    previous["bbox"] = [
                        min(previous["bbox"][0], bbox[0]), min(previous["bbox"][1], bbox[1]),
                        max(previous["bbox"][2], bbox[2]), max(previous["bbox"][3], bbox[3]),
                    ]
                    previous["size"] = max(previous["size"], size)
                    continue
            merged.append({"page": page_number, "block": block_id, "bbox": bbox, "size": size, "spans": spans})
        if merged:
            block_x0 = min(line["bbox"][0] for line in merged)
            block_x1 = max(line["bbox"][2] for line in merged)
            for line in merged:
                line["text"] = _line_text(line["spans"])
                line["block_x0"] = block_x0
                line["block_x1"] = block_x1
            lines.extend(merged)
    return lines


def reading_order(lines):
    """
    Lines of one page in reading order.

    PyMuPDF returns blocks in the order the PDF draws them, which is the
    reading order for most files but not for every two-column layout (a
    right column drawn first, a text box added late). On a two-column page
    the page is cut into bands at blocks spanning both columns (the title,
    a wide table, a figure caption across the page); inside each band the
    left column is read top to bottom, then the right one.

    A single-column page keeps PyMuPDF's order untouched.
    """
    if len(lines) < 10:
        return lines
    x0 = min(l["bbox"][0] for l in lines)
    x1 = max(l["bbox"][2] for l in lines)
    middle = (x0 + x1) / 2
    gutter = 0.02 * (x1 - x0)
    left = [l for l in lines if l["bbox"][2] <= middle + gutter and len(l["text"].split()) >= 5]
    right = [l for l in lines if l["bbox"][0] >= middle - gutter and len(l["text"].split()) >= 5]
    if len(left) < 5 or len(right) < 5:
        return lines

    blocks = defaultdict(list)
    for line in lines:
        blocks[line["block"]].append(line)
    boxes = []
    for block_lines in blocks.values():
        bx0 = min(l["bbox"][0] for l in block_lines)
        bx1 = max(l["bbox"][2] for l in block_lines)
        by0 = min(l["bbox"][1] for l in block_lines)
        by1 = max(l["bbox"][3] for l in block_lines)
        if bx1 <= middle + gutter:
            column = 0
        elif bx0 >= middle - gutter:
            column = 1
        else:
            column = None  # spans both columns
        boxes.append({"lines": block_lines, "y0": by0, "y1": by1, "column": column})

    spanning = sorted((b for b in boxes if b["column"] is None), key=lambda b: b["y0"])
    ordered = []
    placed = set()
    top = float("-inf")
    for separator in spanning + [None]:
        bottom = separator["y0"] if separator else float("inf")
        for column in (0, 1):
            band = [
                b for b in boxes
                if b["column"] == column and id(b) not in placed
                and top - 1 <= (b["y0"] + b["y1"]) / 2 < bottom + 1
            ]
            for b in sorted(band, key=lambda b: b["y0"]):
                ordered.append(b)
                placed.add(id(b))
        if separator is not None:
            ordered.append(separator)
            placed.add(id(separator))
            top = separator["y1"]
    # Anything a band missed (overlapping boxes) keeps its place at the end.
    ordered += [b for b in boxes if id(b) not in placed]
    return [line for b in ordered for line in b["lines"]]


def _body_metrics(lines):
    """Body font size and line spacing (top-to-top), from lines of at least
    five words — the same notion of "body" extractor.get_body_font_size uses."""
    sizes = Counter(round(l["size"], 1) for l in lines if len(l["text"].split()) >= 5)
    body_size = sizes.most_common(1)[0][0] if sizes else 10.0
    steps = []
    for a, b in zip(lines, lines[1:]):
        if a["block"] == b["block"] and abs(a["size"] - body_size) < 0.6:
            step = b["bbox"][1] - a["bbox"][1]
            if 0 < step < 3 * body_size:
                steps.append(step)
    steps.sort()
    spacing = steps[len(steps) // 2] if steps else body_size * 1.2
    return body_size, spacing


# --- Page furniture (running headers, footers, page numbers) ----------------

def _edge_zone(page_lines, height, body_size, top):
    """The rows at the top (or bottom) edge of a page that are cut off from
    the content by a clear gap: where a running header or footer sits.
    Empty when the content runs right up to the edge."""
    if not page_lines:
        return []
    ordered = sorted(page_lines, key=lambda l: l["bbox"][1] if top else -l["bbox"][3])
    limit = FURNITURE_REGION * height
    zone = []
    for current, following in zip(ordered, ordered[1:] + [None]):
        inside = current["bbox"][3] <= limit if top else current["bbox"][1] >= height - limit
        if not inside or len(current["text"].split()) > FURNITURE_MAX_WORDS:
            return []
        zone.append(current)
        if following is None:
            return []
        gap = following["bbox"][1] - current["bbox"][3] if top else current["bbox"][1] - following["bbox"][3]
        if gap >= 1.5 * body_size:
            return zone
    return []


def _furniture(pages, body_size):
    """ids of header/footer lines, and per page the y limits above/below
    which images are furniture too.

    A row at the page edge, cut off by a gap, is furniture when a row sits
    at the same height on other pages too (a running header changes its
    words per chapter but not its position), or when it is a bare page
    number."""
    zones = {}
    buckets = Counter()
    for page in pages:
        for top in (True, False):
            zone = _edge_zone(page["lines"], page["height"], body_size, top)
            zones[(page["number"], top)] = zone
            for line in zone:
                y = line["bbox"][1] if top else page["height"] - line["bbox"][3]
                buckets[(top, round(y / 4))] += 1

    pages_with_text = sum(1 for p in pages if p["lines"]) or 1
    needed = max(2, int(0.3 * pages_with_text + 0.999))

    def recurring(top, y):
        bucket = round(y / 4)
        return buckets[(top, bucket - 1)] + buckets[(top, bucket)] + buckets[(top, bucket + 1)] >= needed

    furniture_ids = set()
    limits = {}
    for page in pages:
        header_limit, footer_limit = None, None
        for top in (True, False):
            for line in zones[(page["number"], top)]:
                y = line["bbox"][1] if top else page["height"] - line["bbox"][3]
                if recurring(top, y) or PAGE_NUMBER_RE.match(line["text"]):
                    furniture_ids.add(id(line))
                    if top:
                        header_limit = max(header_limit or 0, line["bbox"][3])
                    else:
                        footer_limit = min(footer_limit or page["height"], line["bbox"][1])
        limits[page["number"]] = (header_limit, footer_limit)
    return furniture_ids, limits


# --- Table of contents ------------------------------------------------------

def _rows(page_lines):
    """Lines of one page grouped into visual rows, top to bottom."""
    rows = []
    for line in sorted(page_lines, key=lambda l: (l["bbox"][1], l["bbox"][0])):
        center = (line["bbox"][1] + line["bbox"][3]) / 2
        if rows and abs(rows[-1]["center"] - center) < 0.4 * line["size"]:
            rows[-1]["lines"].append(line)
            continue
        rows.append({"center": center, "lines": [line]})
    for row in rows:
        row["lines"].sort(key=lambda l: l["bbox"][0])
        row["text"] = " ".join(l["text"] for l in row["lines"])
    return rows


def _normalized(text):
    return re.sub(r"\s+", " ", text).strip().lower().rstrip(":")


def _toc_line_ids(pages):
    """ids of the lines that make up a table of contents (or list of
    figures/tables): a "Contents" title followed by rows ending in a page
    number, or a run of rows with dot leaders. These are navigation, not
    content: left out of headings, sections and the checked text."""
    toc_ids = set()
    carrying = False  # the previous page ended inside a TOC
    for page in pages:
        rows = _rows(page["lines"])
        right_edge = max((l["bbox"][2] for l in page["lines"]), default=0)
        i = 0
        while i < len(rows):
            row = rows[i]
            titled = _normalized(row["text"]) in TOC_TITLES
            if not (titled or carrying or _toc_like(row, right_edge)):
                i += 1
                continue
            start = i
            j = i + 1 if titled else i
            entries, leaders, pending = 0, 0, 0
            while j < len(rows):
                if _toc_like(rows[j], right_edge):
                    entries += 1 + pending
                    pending = 0
                    if TOC_LEADER_RE.search(rows[j]["text"]):
                        leaders += 1
                    j += 1
                elif pending == 0 and len(rows[j]["text"].split()) <= 12 and j + 1 < len(rows) and _toc_like(rows[j + 1], right_edge):
                    pending = 1  # an entry title wrapped onto two rows
                    j += 1
                else:
                    break
            end = j - pending
            accepted = (titled and entries >= 2) or (carrying and entries >= 1) or (entries >= 4 and leaders * 2 >= entries)
            if accepted:
                for row_index in range(start, end):
                    toc_ids.update(id(l) for l in rows[row_index]["lines"])
                carrying = end >= len(rows)
                i = end
            else:
                carrying = False
                i = start + 1
        if not rows:
            carrying = False
    return toc_ids


def _toc_like(row, right_edge):
    text = row["text"]
    if TOC_LEADER_RE.search(text):
        return True
    last = row["lines"][-1]
    # "Introduction ............ 2" without drawn dots: the page number is a
    # fragment of its own, pushed to the right margin, far from the title.
    return (
        len(row["lines"]) >= 2
        and TOC_NUMBER_RE.match(last["text"].strip()) is not None
        and last["bbox"][2] >= right_edge - 3 * last["size"]
        and last["bbox"][0] - row["lines"][-2]["bbox"][2] > 4 * last["size"]
    )


# --- Captions ---------------------------------------------------------------

def _mark_captions(lines):
    """Tag every line of a caption block ("Table 2: ...", "Figure 3. ...")
    with `caption` = "table" | "figure" and `caption_id`. Only the first
    line of a block can open a caption, so "Table 2 shows ..." wrapped onto
    the start of a line mid-paragraph is not one."""
    first_of_block = {}
    for line in lines:
        first_of_block.setdefault(line["block"], line)
    kinds = {}
    for block_id, line in first_of_block.items():
        text = line["text"].strip()
        if TABLE_CAPTION_RE.match(text):
            kinds[block_id] = "table"
        elif FIGURE_CAPTION_RE.match(text):
            kinds[block_id] = "figure"
    last_of_caption = {}
    for line in lines:
        kind = kinds.get(line["block"])
        if kind:
            line["caption"] = kind
            line["caption_id"] = line["block"]
            last_of_caption[line["block"]] = line
    # A caption wrapped onto lines PyMuPDF put in a block of their own:
    # the lines right under it, inside its width, in the same type size.
    by_page = defaultdict(list)
    for line in lines:
        by_page[line["page"]].append(line)
    for caption_id, last in last_of_caption.items():
        left = min(l["bbox"][0] for l in by_page[last["page"]] if l.get("caption_id") == caption_id)
        right = max(l["bbox"][2] for l in by_page[last["page"]] if l.get("caption_id") == caption_id)
        while True:
            below = [
                l for l in by_page[last["page"]]
                if not l.get("caption") and -0.5 * last["size"] <= l["bbox"][1] - last["bbox"][3] < 0.6 * last["size"]
                and l["bbox"][1] > last["bbox"][1] + 0.5 * last["size"]
                and l["bbox"][0] >= left - last["size"] and l["bbox"][2] <= right + 2 * last["size"]
                and abs(l["size"] - last["size"]) < 0.6
            ]
            if not below:
                break
            nxt = min(below, key=lambda l: l["bbox"][1])
            nxt["caption"] = last["caption"]
            nxt["caption_id"] = caption_id
            last = nxt


# --- Tables -----------------------------------------------------------------

def _drawings(page):
    """The page's vector paths in PyMuPDF's raw form (tuples, no Point
    objects): `get_drawings()` builds Python objects for every point and
    takes seconds on a page with a dense plot."""
    try:
        return page.get_cdrawings()
    except Exception:
        logger.exception("Could not read drawings on page %s", page.number + 1)
        return []


def _horizontal_rules(drawings):
    """Thin horizontal lines drawn on the page as (x0, y, x1): table rules
    (booktabs top/mid/bottom, \\hline)."""
    rules = []
    for drawing in drawings:
        for item in drawing.get("items", []):
            kind = item[0]
            if kind == "l":
                (ax, ay), (bx, by) = item[1], item[2]
                if abs(ay - by) < 1.5 and abs(bx - ax) > 20:
                    rules.append((min(ax, bx), (ay + by) / 2, max(ax, bx)))
            elif kind == "re":
                x0, y0, x1, y1 = item[1]
                if abs(y1 - y0) < 2 and abs(x1 - x0) > 20:
                    rules.append((min(x0, x1), (y0 + y1) / 2, max(x0, x1)))
    return rules


def _words_in(page, rect):
    try:
        return [w for w in page.get_text("words", clip=rect) if w[4].strip()]
    except Exception:
        return []


def _word_rows(words, size):
    rows = []
    for w in sorted(words, key=lambda w: ((w[1] + w[3]) / 2, w[0])):
        center = (w[1] + w[3]) / 2
        if rows and abs(rows[-1]["center"] - center) < 0.45 * size:
            rows[-1]["words"].append(w)
            continue
        rows.append({"center": center, "words": [w]})
    for row in rows:
        row["words"].sort(key=lambda w: w[0])
        row["y0"] = min(w[1] for w in row["words"])
        row["y1"] = max(w[3] for w in row["words"])
        row["x0"] = min(w[0] for w in row["words"])
        row["x1"] = max(w[2] for w in row["words"])
    return rows


def _segments(row, size):
    """Words of a row joined into cell-sized runs: a gap wider than about
    one character width separates two cells."""
    segments = []
    for w in row["words"]:
        if segments and w[0] - segments[-1]["x1"] < 0.8 * size:
            segments[-1]["words"].append(w)
            segments[-1]["x1"] = max(segments[-1]["x1"], w[2])
            continue
        segments.append({"x0": w[0], "x1": w[2], "words": [w]})
    for s in segments:
        s["text"] = " ".join(w[4] for w in s["words"])
    return segments


def _column_bounds(rows, size):
    """Column x ranges from where the rows' words leave gaps in common. A
    header spanning several columns covers a gutter in one row only, so a
    gutter only needs to be empty in most rows, not all."""
    x0 = int(min(r["x0"] for r in rows))
    x1 = int(max(r["x1"] for r in rows)) + 1
    coverage = [0] * (x1 - x0 + 2)
    for row in rows:
        covered = set()
        for s in _segments(row, size):
            covered.update(range(int(s["x0"]) - x0, int(s["x1"]) - x0 + 1))
        for x in covered:
            coverage[x] += 1
    allowed = max(1, int(0.25 * len(rows)))
    columns, start = [], None
    for x, count in enumerate(coverage):
        if count > allowed and start is None:
            start = x
        elif count <= allowed and start is not None:
            columns.append([start + x0, x + x0])
            start = None
    if start is not None:
        columns.append([start + x0, len(coverage) + x0])
    # A gutter narrower than a space is only the gap between two words.
    merged = []
    for column in columns:
        if merged and column[0] - merged[-1][1] < 0.35 * size:
            merged[-1][1] = column[1]
        else:
            merged.append(column)
    return [tuple(c) for c in merged if c[1] - c[0] >= 0.5 * size]


def _column_of(columns, x0, x1):
    center = (x0 + x1) / 2
    return min(
        range(len(columns)),
        key=lambda i: 0 if columns[i][0] - 1 <= center <= columns[i][1] + 1
        else min(abs(columns[i][0] - center), abs(columns[i][1] - center)),
    )


def _grid(rows, size, rules):
    columns = _column_bounds(rows, size)
    if len(columns) < 2:
        return None
    grid = []
    previous_row = None
    for row in rows:
        cells = [""] * len(columns)
        for seg in _segments(row, size):
            spans = [i for i, c in enumerate(columns) if c[0] < seg["x1"] and seg["x0"] < c[1]]
            if len(spans) <= 1:
                index = _column_of(columns, seg["x0"], seg["x1"])
                cells[index] = (cells[index] + " " + seg["text"]).strip()
                continue
            # A run over several columns: words that each sit in one column
            # are separate cells set close together; a word crossing a
            # gutter makes it a header spanning columns, kept whole.
            if all(sum(1 for c in columns if c[0] < w[2] and w[0] < c[1]) <= 1 for w in seg["words"]):
                for w in seg["words"]:
                    index = _column_of(columns, w[0], w[2])
                    cells[index] = (cells[index] + " " + w[4]).strip()
            else:
                cells[spans[0]] = (cells[spans[0]] + " " + seg["text"]).strip()
        ruled = previous_row is not None and any(
            previous_row["y1"] - 1 < y < row["y0"] + 1 for _x0, y, _x1 in rules
        )
        if (
            grid and not cells[0] and grid[-1][0] and not ruled
            and row["y0"] - previous_row["y1"] < 0.6 * size
        ):
            # A cell wrapped onto a second line: same row, more text.
            grid[-1] = [(a + " " + b).strip() for a, b in zip(grid[-1], cells)]
        else:
            grid.append(cells)
        previous_row = row
    # Columns no row uses are leftovers of the coverage threshold.
    used = [i for i in range(len(columns)) if any(r[i] for r in grid)]
    return [[r[i] for i in used] for r in grid]


def _grid_is_reliable(grid):
    if not grid or len(grid) < 2:
        return False
    cols = len(grid[0])
    if cols < 2 or cols > 10:
        return False
    cells = [c for row in grid for c in row]
    empty = sum(1 for c in cells if not c)
    if empty / len(cells) > 0.35:
        return False
    return max(len(c) for c in cells) <= 300


def _column_range(page_lines, caption, body_size, margin):
    """x range a table or figure next to `caption` can take: one column of
    a two-column page when the caption sits in it, else the text width.
    A page is two-column when running text sits in each half on its own."""
    page_x0 = min(l["bbox"][0] for l in page_lines)
    page_x1 = max(l["bbox"][2] for l in page_lines)
    middle = (page_x0 + page_x1) / 2
    left = sum(1 for l in page_lines if l["bbox"][2] < middle and len(l["text"].split()) >= 5)
    right = sum(1 for l in page_lines if l["bbox"][0] > middle and len(l["text"].split()) >= 5)
    if left >= 5 and right >= 5:
        if caption.x1 < middle + body_size:
            return page_x0 - margin, middle + body_size
        if caption.x0 > middle - body_size:
            return middle - body_size, page_x1 + margin
    return page_x0 - margin, page_x1 + margin


def _prose_width(row, size):
    """Width of the widest long unbroken run of words in a row (running
    text, not table cells); 0 when the row has none."""
    return max((s["x1"] - s["x0"] for s in _segments(row, size) if len(s["words"]) >= 10), default=0)


def _rule_extent(caption_rect, rules, rows_between, body_size, page_height, below):
    """The y range and x range of a ruled table next to a caption: from the
    rule nearest the caption, through the rules that follow it with only
    table rows between them (booktabs top/mid/bottom rules, \\hline grids).
    None when there is no rule by the caption."""
    def overlaps(rule):
        return min(rule[2], caption_rect.x1) - max(rule[0], caption_rect.x0) > 0.3 * min(
            rule[2] - rule[0], caption_rect.width
        )

    edge = caption_rect.y1 if below else caption_rect.y0
    ordered = sorted(
        (r for r in rules if overlaps(r) and ((r[1] >= edge - 2) if below else (r[1] <= edge + 2))),
        key=lambda r: r[1] if below else -r[1],
    )
    if not ordered or abs(ordered[0][1] - edge) > 3 * body_size:
        return None
    first = ordered[0]
    chain = [first]
    for rule in ordered[1:]:
        if rule[0] < first[0] - 6 or rule[2] > first[2] + 6:
            continue  # a wider rule is not this table's
        last = chain[-1][1]
        if abs(rule[1] - last) > 0.6 * page_height:
            break
        y0, y1 = sorted((last, rule[1]))
        between = [r for r in rows_between if y0 < r["center"] < y1]
        # Running text between two rules (a paragraph between this table and
        # a footnote rule) spans the table's width; a long table cell does not.
        width = first[2] - first[0]
        if any(r.get("heading_or_caption") for r in between) or any(
            r["prose_width"] >= 0.85 * width for r in between
        ):
            break
        chain.append(rule)
    ys = [r[1] for r in chain]
    return fitz.Rect(min(r[0] for r in chain), min(ys), max(r[2] for r in chain), max(ys))


def _table_region(page, caption_lines, page_lines, body_size, rules, limits, below):
    """The box of the table next to a caption, or None.

    Ruled tables (nearly all of them in papers and reports) are bounded by
    their rules. Without rules, rows are walked away from the caption until
    the table ends: a wide gap, a line of running text, a heading, another
    caption or the page furniture."""
    caption_rect = fitz.Rect(
        min(l["bbox"][0] for l in caption_lines), min(l["bbox"][1] for l in caption_lines),
        max(l["bbox"][2] for l in caption_lines), max(l["bbox"][3] for l in caption_lines),
    )
    page_x0 = min(l["bbox"][0] for l in page_lines)
    page_x1 = max(l["bbox"][2] for l in page_lines)
    x0, x1 = _column_range(page_lines, caption_rect, body_size, margin=2)
    header_limit, footer_limit = limits
    top = (header_limit or 0) + 1
    bottom = (footer_limit or page.rect.height) - 1

    caption_ids = {id(l) for l in caption_lines}
    stops = [
        fitz.Rect(l["bbox"]) for l in page_lines
        if id(l) not in caption_ids and (l.get("caption") or l["size"] >= body_size + 2)
    ]
    area = fitz.Rect(page_x0 - 2, top, page_x1 + 2, bottom)
    all_rows = _word_rows(_words_in(page, area), body_size)
    for row in all_rows:
        row["prose_width"] = _prose_width(row, body_size)
        row["heading_or_caption"] = any(s.y0 - 1 <= row["center"] <= s.y1 + 1 for s in stops)
        row["stop"] = row["prose_width"] > 0 or row["heading_or_caption"]

    ruled = _rule_extent(caption_rect, rules, all_rows, body_size, page.rect.height, below)
    if ruled is not None and ruled.height > body_size:
        return fitz.Rect(ruled.x0 - 1, ruled.y0 - 1, ruled.x1 + 1, ruled.y1 + 1)

    candidates = [
        r for r in all_rows
        if r["x0"] >= x0 and r["x1"] <= x1
        and ((r["y0"] > caption_rect.y1 - 1) if below else (r["y1"] < caption_rect.y0 + 1))
    ]
    if not below:
        candidates.reverse()
    kept = []
    edge = caption_rect.y1 if below else caption_rect.y0
    for row in candidates:
        gap = row["y0"] - edge if below else edge - row["y1"]
        if gap > 2.2 * body_size or row["stop"]:
            break
        kept.append(row)
        edge = row["y1"] if below else row["y0"]
    if len(kept) < 2:
        return None
    return fitz.Rect(
        min(r["x0"] for r in kept) - 2, min(r["y0"] for r in kept) - 2,
        max(r["x1"] for r in kept) + 2, max(r["y1"] for r in kept) + 2,
    )


def _detect_tables(page, page_lines, body_size, spacing, limits, drawings):
    tables = []
    caption_groups = defaultdict(list)
    for line in page_lines:
        if line.get("caption") == "table":
            caption_groups[line["caption_id"]].append(line)
    if not caption_groups:
        return tables
    rules = _horizontal_rules(drawings)
    for caption_id, caption_lines in caption_groups.items():
        cap_y0 = min(l["bbox"][1] for l in caption_lines)
        cap_y1 = max(l["bbox"][3] for l in caption_lines)
        rule_below = any(0 <= y - cap_y1 < 2 * body_size for _x0, y, _x1 in rules)
        rule_above = any(0 <= cap_y0 - y < 2 * body_size for _x0, y, _x1 in rules)
        order = (True, False) if rule_below or not rule_above else (False, True)
        for below in order:
            rect = _table_region(page, caption_lines, page_lines, body_size, rules, limits, below)
            if rect is None or any(rect.intersects(t["bbox"]) for t in tables):
                continue
            caption_ids = {id(l) for l in caption_lines}
            rows = [
                r for r in _word_rows(_words_in(page, rect), body_size)
                if not any(
                    id(l) not in caption_ids and l.get("caption") and abs((l["bbox"][1] + l["bbox"][3]) / 2 - r["center"]) < 2
                    for l in page_lines
                )
            ]
            if len(rows) < 2:
                continue
            grid = _grid(rows, body_size, rules)
            if not grid or len(grid) < 2 or len(grid[0]) < 2:
                continue
            tables.append({
                "page": page_lines[0]["page"],
                "bbox": rect,
                "rows": grid,
                "reliable": _grid_is_reliable(grid),
                "caption_id": caption_id,
                "caption_below": not below,
                "_render_page": page,
            })
            break
    return tables


# --- Figures ----------------------------------------------------------------

def _image_page_counts(doc):
    counts = Counter()
    for page in doc:
        try:
            xrefs = {img[0] for img in page.get_images(full=True)}
        except Exception:
            continue
        counts.update(xrefs)
    return counts


def _detect_figures(page, page_number, page_lines, body_size, limits, repeated_xrefs, table_rects, drawings):
    area = page.rect.width * page.rect.height
    header_limit, footer_limit = limits
    candidates = []

    def is_furniture(rect):
        if header_limit is not None and rect.y1 <= header_limit + 4:
            return True
        if footer_limit is not None and rect.y0 >= footer_limit - 4:
            return True
        return False

    try:
        infos = page.get_image_info(xrefs=True)
    except Exception:
        infos = []
    for info in infos:
        rect = fitz.Rect(info["bbox"]) & page.rect
        if rect.is_empty or info.get("xref") in repeated_xrefs:
            continue
        share = rect.width * rect.height / area
        if share < MIN_FIGURE_AREA_SHARE or share > BACKGROUND_AREA_SHARE or is_furniture(rect):
            continue
        candidates.append({"rect": rect, "raster": True})

    captions = defaultdict(list)
    for line in page_lines:
        if line.get("caption") == "figure":
            captions[line["caption_id"]].append(line)
    caption_rects = [
        fitz.Rect(min(l["bbox"][0] for l in ls), min(l["bbox"][1] for l in ls),
                  max(l["bbox"][2] for l in ls), max(l["bbox"][3] for l in ls))
        for ls in captions.values()
    ]
    # Vector figures (plots, diagrams) are only looked for next to a
    # "Figure N" caption: boxes and shading around text are drawings too.
    paths = []
    for drawing in drawings if caption_rects else []:
        rect = fitz.Rect(drawing["rect"])
        if not rect.intersects(page.rect) and rect.width >= 1 and rect.height >= 1:
            continue
        if rect.width < 1 and rect.height < 1:
            continue
        if rect.width * rect.height > BACKGROUND_AREA_SHARE * area or is_furniture(rect):
            continue
        if any(rect.intersects(t) for t in table_rects):
            continue
        paths.append(rect)
    for caption in caption_rects:
        rect = _paths_by_caption(caption, paths, page_lines, body_size)
        if rect is None or rect.height < 30 or rect.width < 60:
            continue
        if rect.width * rect.height / area < MIN_FIGURE_AREA_SHARE:
            continue
        candidates.append({"rect": rect, "raster": False})

    # Overlapping pieces (a raster plot with vector axes) are one figure.
    merged = []
    for candidate in sorted(candidates, key=lambda c: (c["rect"].y0, c["rect"].x0)):
        for figure in merged:
            grown = fitz.Rect(figure["rect"])
            grown.x0 -= 4; grown.y0 -= 4; grown.x1 += 4; grown.y1 += 4
            if grown.intersects(candidate["rect"]):
                figure["rect"] |= candidate["rect"]
                break
        else:
            merged.append({"rect": fitz.Rect(candidate["rect"])})

    figures = []
    for figure in merged:
        rect = figure["rect"]
        if any(rect.intersects(t) for t in table_rects):
            continue
        # Labels drawn as text inside the figure (axis ticks, legends)
        # belong to the picture, not the flow. Long lines inside mean the
        # "figure" is a background behind real text: leave it alone.
        inside = [
            l for l in page_lines
            if not l.get("caption") and fitz.Rect(l["bbox"]).intersect(rect).get_area()
            >= 0.6 * max(fitz.Rect(l["bbox"]).get_area(), 1)
        ]
        if sum(1 for l in inside if len(l["text"].split()) > 10 and l["size"] >= body_size - 0.5) >= 2:
            continue
        figures.append({
            "page": page_number,
            "bbox": rect,
            "absorbed": {id(l) for l in inside},
            "_render_page": page,
        })
    return figures


def _paths_by_caption(caption, paths, page_lines, body_size):
    """The box of the drawing a figure caption belongs to: the paths
    between the caption and the running text before it (figures are
    captioned underneath), or failing that after it."""
    # Frames and plots may reach a little past the text margins.
    x0, x1 = _column_range(page_lines, caption, body_size, margin=20)

    def text_wall(line):
        # Running text, a heading or another caption: where a figure stops.
        # Text inside a figure is set smaller than the body, so it is not.
        if line.get("caption") or line["size"] >= body_size + 2:
            return True
        return len(line["text"].split()) >= 8 and line["size"] >= body_size - 0.5

    for above in (True, False):
        walls = [
            fitz.Rect(l["bbox"]) for l in page_lines
            if text_wall(l)
            and min(l["bbox"][2], x1) - max(l["bbox"][0], x0) > 0.5 * (l["bbox"][2] - l["bbox"][0])
            and (l["bbox"][3] <= caption.y0 - 1 if above else l["bbox"][1] >= caption.y1 + 1)
            and not (caption.y0 - 1 <= l["bbox"][1] <= caption.y1 + 1)
        ]
        if above:
            limit = max((w.y1 for w in walls), default=0)
            found = [p for p in paths if p.x0 >= x0 and p.x1 <= x1 and p.y0 >= limit - 1 and p.y1 <= caption.y0 + 2]
        else:
            limit = min((w.y0 for w in walls), default=float("inf"))
            found = [p for p in paths if p.x0 >= x0 and p.x1 <= x1 and p.y0 >= caption.y1 - 2 and p.y1 <= limit + 1]
        if found:
            rect = fitz.Rect(found[0])
            for p in found[1:]:
                rect |= p
            return rect
    return None


def _snapshot(page, rect):
    """PNG of one region of a page, as the reader sees it."""
    try:
        longest = max(rect.width, rect.height) or 1
        dpi = min(SNAPSHOT_DPI, int(SNAPSHOT_MAX_PIXELS * 72 / longest))
        pixmap = page.get_pixmap(clip=rect, dpi=max(dpi, 50))
        return pixmap.tobytes("png")
    except Exception:
        logger.exception("Could not render a figure/table snapshot on page %s", page.number + 1)
        return None


# --- Whole document ---------------------------------------------------------

def analyze_pdf(pdf_path, media=True):
    """
    Returns {
      "lines":  content lines in reading order (each {"page", "block",
                "bbox", "size", "spans", "text", "block_x0", "block_x1",
                optional "caption"/"caption_id"}) — page furniture, the
                table of contents, and the text of detected tables and
                figure labels removed;
      "tables": [{"page", "rows", "reliable", "caption_id", "image_bytes"?,
                  "anchor": (page, y)}];
      "figures": [{"page", "image_bytes", "anchor": (page, y)}];
      "rotated_pages": [page numbers read through an upright copy];
    }
    With media=False (source papers, where only the text matters) tables
    and figures are not looked for, and their text stays in the lines.
    """
    doc = fitz.open(pdf_path)
    keep_alive = []
    try:
        return _analyze(doc, media, keep_alive)
    finally:
        for extra in keep_alive:
            extra.close()
        doc.close()


def _analyze(doc, media, keep_alive):
    pages = []
    rotated_pages = []
    for index, page in enumerate(doc):
        number = index + 1
        try:
            data = page.get_text("dict")
            rotation = dominant_rotation(data)
            work_page = page
            if rotation:
                upright = fitz.open()
                keep_alive.append(upright)
                rect = page.rect
                work_page = upright.new_page(width=rect.height, height=rect.width)
                work_page.show_pdf_page(work_page.rect, doc, index, rotate=rotation)
                data = work_page.get_text("dict")
                rotated_pages.append(number)
            lines = reading_order(_page_lines(data, number))
            # Positions on a page shown as-is: the PDF viewer can draw a
            # highlight there (pdf_geometry.py). Not on a sideways page read
            # through an upright copy, nor on one the PDF itself rotates.
            exact = not rotation and page.rotation == 0
            for line in lines:
                line["page_height"] = work_page.rect.height
                line["exact_position"] = exact
        except Exception:
            logger.exception("Could not read page %d; skipping it.", number)
            work_page, lines, rotation = page, [], 0
        pages.append({
            "number": number,
            "page": work_page,
            "height": work_page.rect.height,
            "width": work_page.rect.width,
            "rotated": bool(rotation),
            "lines": lines,
        })

    all_lines = [l for p in pages for l in p["lines"]]
    body_size, spacing = _body_metrics(all_lines)
    furniture_ids, limits = _furniture(pages, body_size)
    for page in pages:
        page["lines"] = [l for l in page["lines"] if id(l) not in furniture_ids]
    toc_ids = _toc_line_ids(pages)
    for page in pages:
        page["lines"] = [l for l in page["lines"] if id(l) not in toc_ids]

    all_lines = [l for p in pages for l in p["lines"]]
    _mark_captions(all_lines)

    tables, figures = [], []
    if media:
        counts = _image_page_counts(doc)
        page_total = len(doc) or 1
        repeated = {
            xref for xref, n in counts.items()
            if n >= REPEATED_IMAGE_MIN_PAGES or (n >= 2 and n / page_total >= REPEATED_IMAGE_PAGE_SHARE)
        }
        for page in pages:
            page_lines = page["lines"]
            page_limits = limits.get(page["number"], (None, None))
            drawings = _drawings(page["page"])
            try:
                found = _detect_tables(
                    page["page"], page_lines, body_size, spacing, page_limits, drawings
                ) if page_lines else []
            except Exception:
                logger.exception("Table detection failed on page %d", page["number"])
                found = []
            consumed = set()
            for table in found:
                rect = table["bbox"]
                consumed |= {
                    id(l) for l in page_lines
                    if not l.get("caption") and fitz.Rect(l["bbox"]).intersect(rect).get_area()
                    >= 0.5 * max(fitz.Rect(l["bbox"]).get_area(), 1)
                }
            try:
                figs = _detect_figures(
                    page["page"], page["number"], [l for l in page_lines if id(l) not in consumed],
                    body_size, page_limits, repeated, [t["bbox"] for t in found], drawings,
                )
            except Exception:
                logger.exception("Figure detection failed on page %d", page["number"])
                figs = []
            for figure in figs:
                consumed |= figure.pop("absorbed")
            page["lines"] = [l for l in page_lines if id(l) not in consumed]
            for table in found:
                table["anchor"] = _anchor(page, table, table["bbox"])
                if not table["reliable"]:
                    table["image_bytes"] = _snapshot(table["_render_page"], table["bbox"])
                tables.append(table)
            for figure in figs:
                figure["anchor"] = _anchor(page, figure, figure["bbox"])
                figure["image_bytes"] = _snapshot(figure["_render_page"], figure["bbox"])
                if figure["image_bytes"]:
                    figures.append(figure)

    for item in tables + figures:
        item.pop("_render_page", None)
        item["bbox"] = tuple(item["bbox"])

    lines = [l for p in pages for l in p["lines"]]
    return {
        "lines": lines,
        "tables": tables,
        "figures": figures,
        "rotated_pages": rotated_pages,
        "body_size": body_size,
    }


def _anchor(page, item, rect):
    """Where an item goes in the flow: (page, x0, y0) of its box, so
    extractor.py can put it after the last line above it in the same
    column."""
    return (page["number"], rect.x0, rect.x1, rect.y0)


def starts_new_paragraph(previous, line, body_size):
    """
    Whether `line` begins a new paragraph after `previous` (two body-text
    lines extractor.build_structured_blocks would otherwise join).

    PyMuPDF's block boundaries alone are not paragraphs: LaTeX keeps a
    whole section's text in a few blocks, and a paragraph broken by a page
    or column break continues in a new one. So a paragraph ends where the
    layout says so: a caption starts or ends, a clear vertical gap, a
    first-line indent, or a short last line ending a sentence.
    Lines without positions (synthetic inputs) never split, as before.
    """
    if not previous.get("bbox") or not line.get("bbox"):
        return False
    if previous.get("caption_id") != line.get("caption_id"):
        return True
    ends_sentence = previous["text"].rstrip().endswith(TERMINAL_PUNCTUATION)
    if previous["page"] != line["page"]:
        return ends_sentence
    px0, py0, px1, py1 = previous["bbox"]
    x0, y0, x1, y1 = line["bbox"]
    size = max(line.get("size") or body_size, 1)
    if y0 < py0 - size:
        return ends_sentence  # moved up: the next column
    if y0 - py1 > 0.9 * size:
        return True
    left = line.get("block_x0", x0) if previous.get("block") == line.get("block") else previous.get("block_x0", px0)
    if x0 - left > 0.8 * size and ends_sentence:
        return True
    right = previous.get("block_x1", px1)
    return ends_sentence and px1 < right - 4 * size
