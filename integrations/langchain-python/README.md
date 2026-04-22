# axon-langchain

LangChain (Python) tools backed by [Axon](https://axon.dev).

## Install

```bash
pip install axon-langchain
```

## Usage

### Single tool

```python
from axon import Axon
from axon_langchain import axon_tool
from pydantic import BaseModel, Field

axon = Axon(api_key="ax_live_...")

class WebSearchArgs(BaseModel):
    q: str = Field(description="The search query")

search = axon_tool(
    axon, "serpapi", "search",
    name="web_search",
    description="Search the web for up-to-date results.",
    args_schema=WebSearchArgs,
    via="params",
)

# Use directly
print(search.invoke({"q": "best espresso in lisbon"}))

# Or pass to an agent
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI

agent = create_react_agent(ChatOpenAI(model="gpt-4o-mini"), [search])
```

### All catalog APIs at once

```python
from axon_langchain import all_axon_tools

tools = all_axon_tools(axon)
agent = create_react_agent(ChatOpenAI(model="gpt-4o-mini"), tools)
```

## License

MIT
