import json
import typer
from legal_sim.orchestrator import Orchestrator

app = typer.Typer()

@app.command()
def run(input: str = "sample_input.json"):
    """Run a single request flow from JSON input."""
    with open(input, "r", encoding="utf-8") as f:
        req = json.load(f)
    orch = Orchestrator()
    result = orch.run(req)
    print("Final decision:")
    print(json.dumps(result, indent=2, ensure_ascii=False))

if __name__ == '__main__':
    app()