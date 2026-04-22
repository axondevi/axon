# axon-autogen

[Microsoft AutoGen](https://microsoft.github.io/autogen/) tools backed by [Axon](https://axon.dev).

## Install

```bash
pip install axon-autogen
```

## Usage

```python
from axon import Axon
from axon_autogen import axon_tool
from autogen_agentchat.agents import AssistantAgent
from autogen_ext.models.openai import OpenAIChatCompletionClient

axon = Axon(api_key="ax_live_...")

search = axon_tool(
    axon, "serpapi", "search",
    name="web_search",
    description="Search the web via SerpAPI.",
    via="params",
)

agent = AssistantAgent(
    name="researcher",
    model_client=OpenAIChatCompletionClient(model="gpt-4o-mini"),
    tools=[search],
)
```

## License

MIT
