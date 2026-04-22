# axon-smolagents

[HuggingFace Smolagents](https://github.com/huggingface/smolagents) tools backed by [Axon](https://axon.dev).

## Install

```bash
pip install axon-smolagents
```

## Usage

```python
from axon import Axon
from axon_smolagents import axon_tool
from smolagents import CodeAgent, HfApiModel

axon = Axon(api_key="ax_live_...")

search = axon_tool(
    axon, "serpapi", "search",
    name="web_search",
    description="Search the web via SerpAPI.",
    inputs={
        "q": {"type": "string", "description": "Search query"},
    },
    via="params",
)

agent = CodeAgent(tools=[search], model=HfApiModel())
result = agent.run("Top AI news today?")
```

## License

MIT
