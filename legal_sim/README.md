Legal Committee Simulation Prototype

Run: python -m legal_sim.cli run --input sample_input.json

Files:
- src/legal_sim/cli.py : CLI entrypoint (Typer)
- src/legal_sim/orchestrator.py : Orchestrator and main loop
- src/legal_sim/head.py : HeadNode and subagent stubs
- src/legal_sim/judges.py : Judge panel logic
- sample_input.json : Example request
- logs/: JSONL logs produced by runs

This is a minimal prototype for E2E demonstration.