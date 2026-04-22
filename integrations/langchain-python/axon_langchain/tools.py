"""
LangChain tools backed by Axon.

    from axon import Axon
    from axon_langchain import axon_tool, all_axon_tools

    axon = Axon(api_key="ax_live_...")

    search = axon_tool(
        axon, "serpapi", "search",
        name="web_search",
        description="Search the web via SerpAPI.",
        via="params",
    )
    # search.invoke({"q": "best espresso in lisbon"})

    all_tools = all_axon_tools(axon)
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Literal, Optional

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, create_model

from axon import Axon

Via = Literal["params", "body"]


def _make_loose_schema(name: str, description: str) -> type[BaseModel]:
    """A permissive schema for auto-registered tools. Override per-tool for rigor."""
    return create_model(
        f"{name}Args",
        __doc__=description,
        input=(Dict[str, Any], Field(default_factory=dict, description=description)),
    )


def axon_tool(
    axon: Axon,
    slug: str,
    endpoint: str,
    *,
    name: str,
    description: str,
    args_schema: Optional[type[BaseModel]] = None,
    via: Via = "body",
    shape: Optional[Callable[[Any, Dict[str, Any]], str]] = None,
) -> StructuredTool:
    """Wrap an Axon endpoint as a LangChain StructuredTool."""

    schema = args_schema or _make_loose_schema(name, description)

    def _run(**kwargs: Any) -> str:
        # If loose schema, caller passes {"input": {...}}; unwrap.
        if "input" in kwargs and len(kwargs) == 1 and isinstance(kwargs["input"], dict):
            kwargs = kwargs["input"]

        if via == "params":
            result = axon.call(slug, endpoint, params=kwargs)
        else:
            result = axon.call(slug, endpoint, body=kwargs)

        if shape:
            return shape(result.data, {
                "cost_usdc": result.cost_usdc,
                "cache_hit": result.cache_hit,
            })
        return str(result.data)

    return StructuredTool.from_function(
        func=_run,
        name=name,
        description=description,
        args_schema=schema,
    )


def all_axon_tools(axon: Axon) -> List[StructuredTool]:
    """Fetch the Axon catalog and return one tool per (api, endpoint)."""
    tools: List[StructuredTool] = []

    for api in axon.apis.list():
        for endpoint in api["endpoints"]:
            tools.append(
                axon_tool(
                    axon,
                    api["slug"],
                    endpoint,
                    name=f"{api['slug']}__{endpoint}",
                    description=(
                        f"{api['provider']} — {api['category']}: {api['description']}"
                    ),
                )
            )

    return tools
