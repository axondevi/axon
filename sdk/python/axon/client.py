"""
Axon — Python client.

    from axon import Axon

    axon = Axon(api_key=os.environ["AXON_KEY"])

    result = axon.call("serpapi", "search", params={"q": "espresso"})
    print(result.data, result.cost_usdc, result.cache_hit)

    balance = axon.wallet.balance()
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Mapping, Optional

import httpx

DEFAULT_BASE_URL = "https://axon-kedb.onrender.com"


class AxonError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        meta: Optional[Mapping[str, Any]] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.meta = dict(meta) if meta else None

    def __repr__(self) -> str:
        return f"AxonError(status={self.status}, code={self.code!r}, message={str(self)!r})"


@dataclass
class CallResult:
    data: Any
    cost_usdc: str
    cache_hit: bool
    latency_ms: int
    status: int
    headers: Dict[str, str]


class _HTTP:
    def __init__(
        self,
        api_key: str,
        base_url: str,
        user_agent: str,
        timeout: float,
        client: Optional[httpx.Client],
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.user_agent = user_agent
        self._owns_client = client is None
        self.client = client or httpx.Client(timeout=timeout)

    def request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        json: Any = None,
    ) -> httpx.Response:
        url = f"{self.base_url}{path}"
        headers = {
            "x-api-key": self.api_key,
            "user-agent": self.user_agent,
        }
        res = self.client.request(
            method, url, params=params, json=json, headers=headers
        )
        if res.status_code >= 400:
            try:
                payload = res.json()
            except Exception:
                payload = {}
            raise AxonError(
                res.status_code,
                payload.get("error", "http_error"),
                payload.get("message", f"HTTP {res.status_code}"),
                payload.get("meta"),
            )
        return res

    def close(self) -> None:
        if self._owns_client:
            self.client.close()


class Axon:
    def __init__(
        self,
        api_key: Optional[str] = None,
        *,
        base_url: Optional[str] = None,
        timeout: float = 30.0,
        user_agent: str = "axon-client-python/0.1",
        http_client: Optional[httpx.Client] = None,
    ):
        key = api_key or os.environ.get("AXON_KEY")
        if not key:
            raise ValueError("Axon: api_key is required (or set AXON_KEY env var)")

        self._http = _HTTP(
            api_key=key,
            base_url=base_url or os.environ.get("AXON_BASE_URL", DEFAULT_BASE_URL),
            user_agent=user_agent,
            timeout=timeout,
            client=http_client,
        )

        self.wallet = _Wallet(self._http)
        self.apis = _Catalog(self._http)
        self.usage = _Usage(self._http)

        # Inspectable last-call metadata
        self.last_cost: str = "0"
        self.last_cache_hit: bool = False
        self.last_latency_ms: int = 0

    # ─── Main call ────────────────────────────────────
    def call(
        self,
        slug: str,
        endpoint: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        body: Any = None,
    ) -> CallResult:
        path = f"/v1/call/{slug}/{endpoint}"
        method = "POST" if body is not None else "GET"
        res = self._http.request(method, path, params=params, json=body)

        try:
            data = res.json()
        except Exception:
            data = res.text

        cost = res.headers.get("x-axon-cost-usdc", "0")
        hit = res.headers.get("x-axon-cache") == "hit"
        latency = int(res.headers.get("x-axon-latency-ms", 0) or 0)

        self.last_cost = cost
        self.last_cache_hit = hit
        self.last_latency_ms = latency

        return CallResult(
            data=data,
            cost_usdc=cost,
            cache_hit=hit,
            latency_ms=latency,
            status=res.status_code,
            headers=dict(res.headers),
        )

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "Axon":
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()


class _Wallet:
    def __init__(self, http: _HTTP) -> None:
        self._http = http

    def balance(self) -> Dict[str, Any]:
        return self._http.request("GET", "/v1/wallet/balance").json()

    def transactions(self, limit: int = 50) -> List[Dict[str, Any]]:
        r = self._http.request(
            "GET", "/v1/wallet/transactions", params={"limit": limit}
        )
        return r.json()["data"]

    def deposit_intent(self) -> Dict[str, Any]:
        return self._http.request("POST", "/v1/wallet/deposit-intent").json()


class _Catalog:
    def __init__(self, http: _HTTP) -> None:
        self._http = http

    def list(self) -> List[Dict[str, Any]]:
        return self._http.request("GET", "/v1/apis").json()["data"]

    def get(self, slug: str) -> Dict[str, Any]:
        return self._http.request("GET", f"/v1/apis/{slug}").json()


class _Usage:
    def __init__(self, http: _HTTP) -> None:
        self._http = http

    def summary(
        self,
        *,
        from_: Optional[str] = None,
        to: Optional[str] = None,
        api: Optional[str] = None,
    ) -> Dict[str, Any]:
        params: Dict[str, str] = {}
        if from_:
            params["from"] = from_
        if to:
            params["to"] = to
        if api:
            params["api"] = api
        return self._http.request("GET", "/v1/usage", params=params).json()

    def by_api(self) -> List[Dict[str, Any]]:
        return self._http.request("GET", "/v1/usage/by-api").json()["data"]
