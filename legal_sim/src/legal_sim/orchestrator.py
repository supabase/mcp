import json
import os
from typing import Dict, Any, List
from legal_sim.head import HeadNode
from legal_sim.judges import JudgePanel

LOG_DIR = os.path.join(os.path.dirname(__file__), '..', '..', 'legal_sim', 'logs')
if not os.path.exists(LOG_DIR):
    os.makedirs(LOG_DIR, exist_ok=True)

class Orchestrator:
    def __init__(self, heads=5, max_rounds=3):
        self.heads = heads
        self.max_rounds = max_rounds
        self.judges = JudgePanel(n=5)

    def _log(self, name: str, obj: Dict[str, Any]):
        p = os.path.join(LOG_DIR, f"{name}.jsonl")
        with open(p, 'a', encoding='utf-8') as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")

    def run(self, request: Dict[str, Any]) -> Dict[str, Any]:
        round_idx = 0
        aggregated = None
        while round_idx < self.max_rounds:
            heads_outputs = []
            for i in range(self.heads):
                head = HeadNode(i+1)
                out = head.process(request, round_idx)
                heads_outputs.append(out)
            # log
            self._log(f"run_{request.get('request_id')}_round_{round_idx}", {"heads": heads_outputs})
            verdict = self.judges.evaluate(heads_outputs)
            self._log(f"verdict_{request.get('request_id')}_round_{round_idx}", verdict)
            if verdict.get('decision') == 'accept':
                aggregated = {'round': round_idx, 'verdict': verdict, 'heads': heads_outputs}
                break
            else:
                # apply clarification: inject new questions into request based on judge head_ids
                head_ids = verdict.get('head_ids', [])
                # append clarifying question(s) to request.questions
                for hid in head_ids:
                    request.setdefault('questions', []).append(f"Clarify for head {hid}: please specify the timeline of repairs.")
                round_idx += 1
        if aggregated is None:
            aggregated = {'round': round_idx, 'verdict': {'decision': 'max_rounds_reached'}}
        # final log
        self._log(f"final_{request.get('request_id')}", aggregated)
        return aggregated
