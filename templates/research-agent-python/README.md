# Research Agent — Python (LangChain + LangGraph)

Agent that searches the web, scrapes top results, and synthesizes a cited answer.

## Run

```bash
pip install -r requirements.txt

export AXON_KEY=ax_live_...
export OPENAI_API_KEY=sk-...

python agent.py "what are the top espresso bars in lisbon?"
```

## What's happening

- `axon_tool()` wraps SerpAPI and Firecrawl as LangChain tools
- `create_react_agent()` from LangGraph wires them to `gpt-4o-mini`
- Every tool call debits your Axon USDC wallet
- Repeat the same question within an hour — second run is ~50% cheaper (cache)
