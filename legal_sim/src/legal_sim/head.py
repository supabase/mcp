import re
import hashlib
from typing import Dict, Any, List

class SubagentOutput(Dict):
    pass

class HeadNode:
    def __init__(self, head_id: int):
        self.head_id = head_id

    def process(self, request: Dict[str, Any], round_index: int = 0) -> Dict[str, Any]:
        facts = request.get("facts", [])
        questions: List[str] = []
        # QuestionDrafters: produce targeted clarifying questions on first two facts
        for i, f in enumerate(facts[:2]):
            snippet = f[:60]
            questions.append(f"What is the exact date and detail for: \"{snippet}\"?")
        if not questions:
            questions = [f"Please clarify facts for round {round_index}."]

        # FactLinkers: look for explicit 'Article' mentions, otherwise fall back to deterministic mapping
        links: List[str] = []
        for f in facts:
            m = re.search(r'Article\s*\D?(\d+)', f, re.I)
            if m:
                links.append(f"Article-{m.group(1)}")
        if not links:
            # deterministic fallback based on hash of facts + head id
            seed = " ".join(facts) or "no-facts"
            h = hashlib.sha1(f"{self.head_id}:{round_index}:{seed}".encode()).hexdigest()
            links = [f"Article-{int(h[:2],16)%50}", f"Article-{int(h[2:4],16)%50}"]

        # Contradiction detection deferred to JudgePanel (global view). Per-head flag left False.
        contradiction = False

        return {
            "head_id": self.head_id,
            "questions": questions,
            "links": links,
            "contradiction": contradiction,
            "round": round_index
        }
