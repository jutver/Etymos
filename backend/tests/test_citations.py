"""Tests for citations.add_citation: marker insertion, renumbering,
reference-section rebuild, and offset rebasing."""

from citations import (
    add_citation,
    find_reference_section,
    format_reference,
    rebase_offset,
    render_reference_section,
)


SOURCE_A = {"id": "paper_a", "title": "First Paper", "authors": "Nguyen, A.", "year": 2020,
            "url": "https://example.org/a"}
SOURCE_B = {"id": "paper_b", "title": "Second Paper", "authors": ["Tran, B.", "Le, C."],
            "year": 2021, "url": "https://example.org/b"}
SOURCE_C = {"id": "paper_c", "title": "Third Paper", "year": 2019}


def test_first_citation_creates_marker_and_reference_section():
    result = add_citation(
        text="Machine learning improves outcomes.",
        references=[],
        insert_at=len("Machine learning improves outcomes"),
        source=SOURCE_A,
    )

    assert result["citation_number"] == 1
    assert result["inserted_marker"] == "[1]"
    assert result["text"].startswith("Machine learning improves outcomes[1].")
    assert "References" in result["text"]
    assert "[1] Nguyen, A. (2020). First Paper. https://example.org/a" in result["text"]
    assert result["text"][result["reference_section_start"]:] == result["reference_section"]


def test_citing_the_same_source_twice_reuses_its_number():
    first = add_citation("Alpha statement. Beta statement.", [], 15, SOURCE_A)
    second = add_citation(
        first["text"], first["references"], first["text"].index("Beta statement") + 14, SOURCE_A
    )

    assert second["citation_number"] == 1
    assert len(second["references"]) == 1
    assert second["text"].count("[1]") == 3  # two inline markers + the list entry


def test_citation_inserted_earlier_renumbers_existing_markers():
    # Body already cites paper_a as [1]; now cite paper_b BEFORE it.
    text = "First clause. Second clause[1]."
    references = [dict(SOURCE_A)]

    result = add_citation(text, references, insert_at=len("First clause"), source=SOURCE_B)

    # paper_b appears first, so it becomes [1] and paper_a becomes [2].
    assert result["citation_number"] == 1
    assert result["renumbered"] is True
    assert result["text"].startswith("First clause[1]. Second clause[2].")
    assert [r["id"] for r in result["references"]] == ["paper_b", "paper_a"]
    assert "[1] Tran, B., Le, C. (2021). Second Paper." in result["text"]
    assert "[2] Nguyen, A. (2020). First Paper." in result["text"]


def test_citation_appended_after_existing_markers_keeps_their_numbers():
    text = "A[1]. B[2]. C."
    references = [dict(SOURCE_A), dict(SOURCE_B)]

    result = add_citation(text, references, insert_at=len("A[1]. B[2]. C"), source=SOURCE_C)

    assert result["citation_number"] == 3
    assert result["renumbered"] is False
    assert result["text"].startswith("A[1]. B[2]. C[3].")


def test_existing_reference_section_is_replaced_not_duplicated():
    first = add_citation("Alpha statement here.", [], 21, SOURCE_A)
    second = add_citation(first["text"], first["references"], 5, SOURCE_B)

    assert second["text"].count("References") == 1
    assert find_reference_section(second["text"]) is not None


def test_uncited_references_are_preserved_after_the_cited_ones():
    result = add_citation("No markers at all here.", [dict(SOURCE_B)], 2, SOURCE_A)

    ids = [r["id"] for r in result["references"]]
    assert ids == ["paper_a", "paper_b"]  # cited first, then the untouched one


def test_unmanaged_brackets_are_left_alone():
    text = "See [note] and [99] for detail."
    result = add_citation(text, [], 3, SOURCE_A)

    assert "[note]" in result["text"]
    assert "[99]" in result["text"]


def test_offset_map_rebases_offsets_after_the_insertion():
    text = "Alpha beta gamma delta."
    target = text.index("gamma")

    result = add_citation(text, [], insert_at=text.index("beta"), source=SOURCE_A)

    rebased = rebase_offset(target, result["offset_map"])
    assert result["text"][rebased:rebased + 5] == "gamma"


def test_offset_map_rebases_across_renumbering_width_changes():
    # Nine existing references pushes the tenth marker to two digits, so
    # renumbering changes byte lengths, not just numbers.
    references = [{"id": f"paper_{i}", "title": f"Paper {i}"} for i in range(1, 10)]
    body = " ".join(f"Clause {i}[{i}]." for i in range(1, 10)) + " Tail text."
    target = body.index("Tail text")

    result = add_citation(body, references, insert_at=0, source={"id": "new", "title": "New"})

    assert result["citation_number"] == 1
    rebased = rebase_offset(target, result["offset_map"])
    assert result["text"][rebased:rebased + 9] == "Tail text"


def test_insert_position_is_clamped_into_the_body():
    result = add_citation("Short.", [], insert_at=10_000, source=SOURCE_A)

    assert result["insert_at"] == len("Short.")
    assert result["text"].startswith("Short.[1]")


def test_format_reference_degrades_with_partial_metadata():
    assert format_reference({"title": "Only A Title"}) == "Only A Title."
    assert format_reference({"id": "x"}) == "x"
    assert "https://example.org/b" in format_reference(SOURCE_B)


def test_render_reference_section_numbering_matches_list_order():
    section = render_reference_section([SOURCE_A, SOURCE_B])

    assert section.splitlines()[0] == "References"
    assert section.splitlines()[1].startswith("[1] Nguyen, A.")
    assert section.splitlines()[2].startswith("[2] Tran, B., Le, C.")
