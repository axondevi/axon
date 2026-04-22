"""
PydanticAI tools backed by Axon.

    from axon import Axon
    from pydantic_ai import Agent
    from axon_pydantic_ai import register_axon_tool

    axon = Axon(api_key="ax_live_...")
    agent = Agent("openai:gpt-4o-mini")

    register_axon_tool(
        agent, axon, "serpapi", "search",
        name="web_search",
        description="Search the web via SerpAPI.",
        via="params",
    )
"""
from __future__ import annotations

from typing import Any, Dict, Literal

from pydantic_ai import Agent, RunContext

from axon import Axon

Via = Literal["params", "body"]


def register_axon_tool(
    agent: Agent[Any, Any],
    axon: Axon,
    slug: str,
    endpoint: str,
    *,
    name: str,
    description: str,
    via: Via = "body",
) -> None:
    """Register a single Axon endpoint as a tool on a PydanticAI Agent."""

    async def _impl(ctx: RunContext[Any], **kwargs: Any) -> Dict[str, Any]:
        if via == "params":
            res = axon.call(slug, endpoint, params=kwargs)
        else:
            res = axon.call(slug, endpoint, body=kwargs)
        return {
            "data": res.data,
            "_axon": {
                "cost_usdc": res.cost_usdc,
                "cache_hit": res.cache_hit,
                "latency_ms": res.latency_ms,
            },
        }

    agent.tool(name=name, description=description)(_impl)


def register_all(agent: Agent[Any, Any], axon: Axon) -> None:
    """Register every (api, endpoint) in the catalog as a tool."""
    for api in axon.apis.list():
        for endpoint in api["endpoints"]:
            register_axon_tool(
                agent,
                axon,
                api["slug"],
                endpoint,
                name=f"{api['slug']}__{endpoint}",
                description=(
                    f"{api['provider']} — {api['category']}: {api['description']}"
                ),
            )
