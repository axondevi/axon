# axon-pydantic-ai

[PydanticAI](https://ai.pydantic.dev) tools backed by [Axon](https://axon.dev).

## Install

```bash
pip install axon-pydantic-ai
```

## Usage

```python
from axon import Axon
from pydantic_ai import Agent
from axon_pydantic_ai import register_axon_tool, register_all

axon = Axon(api_key="ax_live_...")
agent = Agent("openai:gpt-4o-mini")

# Single tool
register_axon_tool(
    agent, axon, "serpapi", "search",
    name="web_search",
    description="Search the web via SerpAPI.",
    via="params",
)

# ... or the entire catalog
register_all(agent, axon)

result = await agent.run("What's the top AI news today?")
```

## License

MIT
