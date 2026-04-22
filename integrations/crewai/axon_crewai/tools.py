"""
crewAI tools backed by Axon.

    from axon import Axon
    from axon_crewai import axon_tool, all_axon_tools

    axon = Axon(api_key="ax_live_...")

    search = axon_tool(
        axon, "serpapi", "search",
        name="web_search",
        description="Search the web via SerpAPI.",
        via="params",
    )
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Literal, Optional, Type

from crewai.tools import BaseTool
from pydantic import BaseModel, Field, ConfigDict, PrivateAttr, create_model

from axon import Axon

Via = Literal["params", "body"]


class _LooseArgs(BaseModel):
    """Fallback schema: accepts anything."""

    model_config = ConfigDict(extra="allow")


class AxonTool(BaseTool):
    """crewAI-compatible tool that proxies to an Axon endpoint."""

    name: str
    description: str
    args_schema: Type[BaseModel] = _LooseArgs

    _axon: Axon = PrivateAttr()
    _slug: str = PrivateAttr()
    _endpoint: str = PrivateAttr()
    _via: Via = PrivateAttr()
    _shape: Optional[Callable[[Any, Dict[str, Any]], str]] = PrivateAttr(default=None)

    def __init__(
        self,
        axon: Axon,
        slug: str,
        endpoint: str,
        *,
        name: str,
        description: str,
        args_schema: Optional[Type[BaseModel]] = None,
        via: Via = "body",
        shape: Optional[Callable[[Any, Dict[str, Any]], str]] = None,
    ):
        super().__init__(
            name=name,
            description=description,
            args_schema=args_schema or _LooseArgs,
        )
        self._axon = axon
        self._slug = slug
        self._endpoint = endpoint
        self._via = via
        self._shape = shape

    def _run(self, **kwargs: Any) -> str:
        if self._via == "params":
            result = self._axon.call(self._slug, self._endpoint, params=kwargs)
        else:
            result = self._axon.call(self._slug, self._endpoint, body=kwargs)

        if self._shape:
            return self._shape(
                result.data,
                {"cost_usdc": result.cost_usdc, "cache_hit": result.cache_hit},
            )
        return str(result.data)


def axon_tool(
    axon: Axon,
    slug: str,
    endpoint: str,
    *,
    name: str,
    description: str,
    args_schema: Optional[Type[BaseModel]] = None,
    via: Via = "body",
    shape: Optional[Callable[[Any, Dict[str, Any]], str]] = None,
) -> AxonTool:
    """Convenience factory."""
    return AxonTool(
        axon,
        slug,
        endpoint,
        name=name,
        description=description,
        args_schema=args_schema,
        via=via,
        shape=shape,
    )


def all_axon_tools(axon: Axon) -> List[AxonTool]:
    """One tool per (api, endpoint) in the Axon catalog."""
    tools: List[AxonTool] = []
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
