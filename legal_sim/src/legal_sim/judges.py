from typing import List, Dict, Any

class JudgePanel:
    def __init__(self, n=5):
        self.n = n

    def evaluate(self, heads_outputs: List[Dict[str, Any]]) -> Dict[str, Any]:
        # collect contradictions
        contradictions = [h for h in heads_outputs if h.get('contradiction')]
        if contradictions:
            # ask for clarification: request new questions to heads that reported contradictions
            head_ids = [h['head_id'] for h in contradictions]
            return {
                'decision': 'clarify',
                'head_ids': head_ids,
                'message': f'Clarify outputs from heads: {head_ids}'
            }
        else:
            # accept and summarize links
            all_links = []
            for h in heads_outputs:
                all_links.extend(h.get('links', []))
            summary = list(dict.fromkeys(all_links))
            return {
                'decision': 'accept',
                'summary_links': summary,
                'message': 'No contradictions detected; accept consolidated view.'
            }
