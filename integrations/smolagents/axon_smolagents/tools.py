"""
Smolagents (HuggingFace) tools backed by Axon.

    from axon import Axon
    from axon_smolagents import axon_tool
    from smolagents import CodeAgent, HfApiModel

    axon = Axon(api_key="ax_live_...")

    search = axon_tool(
        axon, "serpapi", "search",
        name="web_search",
        description="Search the web via SerpAPI.",
        inputs={"q": {"type": "string", "description": "Search query"}},
        via="params",
    )

    agent = CodeAgent(tools=[search], model=HfApiModel())
"""
from __future__ import annotations

from typing import Any, Dict, Literal

from smolagents import Tool

from axon import Axon

Via = Literal["params", "body"]


class AxonSmolTool(Tool):
    def __init__(
        self,
        axon: Axon,
        slug: str,
        endpoint: str,
        *,
        name: str,
        description: str,
        inputs: Dict[str, Dict[str, Any]],
        output_type: str = "object",
        via: Via = "body",
    ):
        super().__init__()
        self.name = name
        self.description = description
        self.inputs = inputs
        self.output_type = output_type
        self._axon = axon
        self._slug = slug
        self._endpoint = endpoint
        self._via = via

    def forward(self, **kwargs: Any) -> Any:
        if self._via == "params":
            res = self._axon.call(self._slug, self._endpoint, params=kwargs)
        else:
            res = self._axon.call(self._slug, self._endpoint, body=kwargs)
        return {
            "data": res.data,
            "cost_usdc": res.cost_usdc,
            "cache_hit": res.cache_hit,
        }


def axon_tool(
    axon: Axon,
    slug: str,
    endpoint: str,
    *,
    name: str,
    description: str,
    inputs: Dict[str, Dict[str, Any]],
    via: Via = "body",
) -> AxonSmolTool:
    return AxonSmolTool(
        axon, slug, endpoint,
        name=name, description=description,
        inputs=inputs, via=via,
    )


def all_axon_tools(axon: Axon) -> list[AxonSmolTool]:
    tools: list[AxonSmolTool] = []
    for api in axon.apis.list():
        for endpoint in api["endpoints"]:
            tools.append(
                axon_tool(
                    axon, api["slug"], endpoint,
                    name=f"{api['slug']}__{endpoint}",
                    description=(
                        f"{api['provider']} — {api['category']}: {api['description']}"
                    ),
                    inputs={
                        "input": {
                            "type": "object",
                            "description": (
                                f"Arguments for {api['slug']}/{endpoint}. "
                                "See the provider's docs."
                            ),
                        },
                    },
                )
            )
    return tools
