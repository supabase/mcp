import hashlib
from typing import Dict, Any, List

class SubagentOutput(Dict):
    pass

class HeadNode:
    def __init__(self, head_id: int):
        self.head_id = head_id

    def process(self, request: Dict[str, Any], round_index: int = 0) -> Dict[str, Any]:
        text = " ".join(request.get("facts", [])) + " " + " ".join(request.get("questions", []))
        # deterministic pseudo-variation per head
        h = hashlib.sha1(f"{self.head_id}:{round_index}:{text}".encode()).hexdigest()
        # two question drafters
        questions = [f"Clarify point {h[:4]}?", f"Please specify {h[4:8]}?"]
        # two fact linkers -> simulate links to articles
        links = [f"Article-{int(h[:2],16)%20}", f"Article-{int(h[2:4],16)%20}"]
        # contradiction detector: detect 'contradiction' when two links differ by parity
        contradiction = (int(h[0],16) % 2 == 0)
        return {
            "head_id": self.head_id,
            "questions": questions,
            "links": links,
            "contradiction": contradiction,
            "round": round_index
        }
