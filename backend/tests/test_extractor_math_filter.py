"""
Regression tests for extractor.is_heavy_math_line.

The filter exists to keep equations and table rows out of the extracted body
text. It used to count the ASCII hyphen as a math symbol, so any prose line
holding three hyphens ("text-to-text", "state-of-the-art", or a line-end break
like "architec-") was judged an equation and dropped whole — leaving sentences
with a hole in the middle ("By ture, ..." for "By harnessing the power of a
text-to-text architecture, ...").
"""

import pytest

from extractor import is_heavy_math_line

# Real lines from the ViHateT5 abstract (arXiv 2405.14141) that were dropped.
PROSE_LINES_WITH_HYPHENS = [
    "gence of transformer-based pre-trained lan-",
    "fine-tuning general pre-trained models, pri-",
    "harnessing the power of a text-to-text architec-",
    "a unified model and obtain state-of-the-art per-",
    "2023 ). However, current state-of-the-art models",
    "sue of fragmentation, a unified text-to-text-based",
]


@pytest.mark.parametrize("line", PROSE_LINES_WITH_HYPHENS)
def test_hyphenated_prose_is_kept(line):
    assert is_heavy_math_line(line) is False


def test_citation_tail_split_across_lines_is_kept():
    assert is_heavy_math_line("et al. , 2022 ).") is False


@pytest.mark.parametrize(
    "line",
    [
        "(1)",
        "(12a)",
        "y = w x + b + c",  # three operators
        "z = x − y + w × v",  # Unicode minus counts as math
        "a = b - c - d + e",  # spaced minus signs are still operators
        "0.45 0.32 0.11 0.90 0.80",  # table row of numbers
        "1",  # bare page number
        "-",  # stray bullet / separator, no letters
        "( )",
        "arXiv:2405.14141v2  [cs.CL]  4 Jun 2024",  # margin stamp
    ],
)
def test_real_math_and_noise_still_dropped(line):
    assert is_heavy_math_line(line) is True


def test_blank_line_is_dropped():
    assert is_heavy_math_line("   ") is True
