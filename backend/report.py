def print_report(results, top_k=10):
    print("\n===== TOP SIMILAR PAPERS =====\n")

    for i, paper in enumerate(results[:top_k], start=1):
        print(f"{i}. {paper['title']}")
        print(f"Year: {paper['year']}")
        print(f"Source: {paper.get('source', '')}")
        print(f"DOI: {paper['doi']}")
        print(f"URL: {paper.get('url', '')}")
        print(f"Final Similarity: {paper['similarity']:.4f}")

        print("Section Scores:")
        for section, score in paper.get("section_scores", {}).items():
            print(f"  - {section}: {score:.4f}")

        print("-" * 80)