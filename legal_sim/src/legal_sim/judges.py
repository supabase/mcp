from typing import List, Dict, Any
from collections import Counter

class JudgePanel:
    def __init__(self, n=5):
        self.n = n

    def evaluate(self, heads_outputs: List[Dict[str, Any]]) -> Dict[str, Any]:
        # Aggregate all links from heads
        link_list = []
        for h in heads_outputs:
            link_list.extend(h.get('links', []))
        counts = Counter(link_list)

        if not counts:
            # No links found — request clarification from all heads
            return {
                'decision': 'clarify',
                'head_ids': [h['head_id'] for h in heads_outputs],
                'message': 'No legal links detected; request clarification.'
            }

        unique_links = len(counts)
        # If there is large diversity in linked articles, treat as potential contradiction
        if unique_links > 2:
            predominant = counts.most_common(1)[0][0]
            # Find heads that do not reference the predominant article
            head_ids = []
            for h in heads_outputs:
                if predominant not in h.get('links', []):
                    head_ids.append(h['head_id'])
            if not head_ids:
                head_ids = [h['head_id'] for h in heads_outputs]
            return {
                'decision': 'clarify',
                'head_ids': head_ids,
                'message': f'Diverse legal references found: {list(counts.keys())} — request clarification from heads: {head_ids}'
            }
        else:
            # Consolidate and accept
            summary = list(dict.fromkeys(link_list))
            return {
                'decision': 'accept',
                'summary_links': summary,
                'message': 'Consolidated links; no major contradiction detected.'
            }
