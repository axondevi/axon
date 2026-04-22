"""
Minimal Axon Python example.

    AXON_KEY=ax_live_... python python-minimal.py
"""
import os
from axon import Axon

axon = Axon(api_key=os.environ["AXON_KEY"])

res = axon.call("openweather", "current", params={"lat": 38.72, "lon": -9.14})
print("temp (K):", res.data.get("main", {}).get("temp"))
print(f"paid: {res.cost_usdc} USDC{' (cache hit)' if res.cache_hit else ''}")

bal = axon.wallet.balance()
print(f"wallet: {bal['available_usdc']} USDC available")
