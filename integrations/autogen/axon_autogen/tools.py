"""
AutoGen (Microsoft) tools backed by Axon.

    from axon import Axon
    from axon_autogen import axon_tool
    from autogen_agentchat.agents import AssistantAgent

    axon = Axon(api_key="ax_live_...")
    search = axon_tool(axon, "serpapi", "search", name="web_search",
                      description="Search the web.", via="params")

    agent = AssistantAgent(name="researcher", model_client=..., tools=[search])
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Literal, Optional, Type

from autogen_core.tools import BaseTool
from pydantic import BaseModel, ConfigDict

from axon import Axon

Via = Literal["params", "body"]


class _LooseArgs(BaseModel):
    model_config = ConfigDict(extra="allow")


class _LooseResult(BaseModel):
    data: Any = None
    cost_usdc: str = "0"
    cache_hit: bool = False
    model_config = ConfigDict(arbitrary_types_allowed=True)


class AxonAutogenTool(BaseTool[BaseModel, _LooseResult]):
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
    ):
        super().__init__(
            args_type=args_schema or _LooseArgs,
            return_type=_LooseResult,
            name=name,
            description=description,
        )
        self._axon = axon
        self._slug = slug
        self._endpoint = endpoint
        self._via = via

    async def run(self, args: BaseModel, cancellation_token: Any) -> _LooseResult:
        kwargs = args.model_dump() if isinstance(args, BaseModel) else dict(args)
        if self._via == "params":
            res = self._axon.call(self._slug, self._endpoint, params=kwargs)
        else:
            res = self._axon.call(self._slug, self._endpoint, body=kwargs)
        return _LooseResult(
            data=res.data, cost_usdc=res.cost_usdc, cache_hit=res.cache_hit
        )


def axon_tool(
    axon: Axon,
    slug: str,
    endpoint: str,
    *,
    name: str,
    description: str,
    args_schema: Optional[Type[BaseModel]] = None,
    via: Via = "body",
) -> AxonAutogenTool:
    return AxonAutogenTool(
        axon, slug, endpoint,
        name=name, description=description,
        args_schema=args_schema, via=via,
    )


def all_axon_tools(axon: Axon) -> list[AxonAutogenTool]:
    tools: list[AxonAutogenTool] = []
    for api in axon.apis.list():
        for endpoint in api["endpoints"]:
            tools.append(
                axon_tool(
                    axon, api["slug"], endpoint,
                    name=f"{api['slug']}__{endpoint}",
                    description=f"{api['provider']} — {api['category']}: {api['description']}",
                )
            )
    return tools
