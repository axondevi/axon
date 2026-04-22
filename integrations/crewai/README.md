# axon-crewai

[crewAI](https://crewai.com) tools backed by [Axon](https://axon.dev).

## Install

```bash
pip install axon-crewai
```

## Usage

```python
from axon import Axon
from axon_crewai import axon_tool, all_axon_tools
from crewai import Agent, Crew, Task
from pydantic import BaseModel, Field

axon = Axon(api_key="ax_live_...")

# Single tool
class WebSearchArgs(BaseModel):
    q: str = Field(description="The search query")

search = axon_tool(
    axon, "serpapi", "search",
    name="web_search",
    description="Search the web for current results.",
    args_schema=WebSearchArgs,
    via="params",
)

# Or pull everything at once
tools = all_axon_tools(axon)

# Standard crewAI agent
researcher = Agent(
    role="Researcher",
    goal="Find reliable information on any topic",
    backstory="Expert at online research.",
    tools=[search],
)

task = Task(
    description="Research the top espresso bars in Lisbon.",
    agent=researcher,
    expected_output="List of 5 recommended bars with notes.",
)

crew = Crew(agents=[researcher], tasks=[task])
result = crew.kickoff()
```

## Cost telemetry

Every tool call flows through Axon. Check spend via:

```python
summary = axon.usage.summary()
print(summary["total_spent_usdc"], summary["cache_hit_rate"])
```

## License

MIT
