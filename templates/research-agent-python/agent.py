"""
Axon research agent (Python + LangChain).

    python agent.py "what are the top espresso bars in lisbon?"

Env:
    AXON_KEY         — ax_live_ key
    OPENAI_API_KEY   — LLM provider
"""
import os
import sys

from pydantic import BaseModel, Field
from axon import Axon
from axon_langchain import axon_tool
from langchain_openai import ChatOpenAI
from langgraph.prebuilt import create_react_agent


class SearchArgs(BaseModel):
    q: str = Field(description="Search query")


class ScrapeArgs(BaseModel):
    url: str = Field(description="URL to scrape")


def main():
    axon = Axon(api_key=os.environ["AXON_KEY"])

    search = axon_tool(
        axon, "serpapi", "search",
        name="web_search",
        description="Search the web. Returns organic results with title, link, snippet.",
        args_schema=SearchArgs,
        via="params",
    )
    scrape = axon_tool(
        axon, "firecrawl", "scrape",
        name="web_scrape",
        description="Scrape a single URL and return clean markdown.",
        args_schema=ScrapeArgs,
        via="body",
    )

    agent = create_react_agent(
        ChatOpenAI(model="gpt-4o-mini"),
        tools=[search, scrape],
    )

    question = " ".join(sys.argv[1:]) or "top AI news today"
    print(f"\nResearching: {question}\n")

    result = agent.invoke({
        "messages": [{
            "role": "user",
            "content": (
                "Research this: " + question +
                "\n\nSearch, then scrape 2-3 of the top links, then synthesize a concise "
                "answer with source URLs."
            ),
        }],
    })

    final_msg = result["messages"][-1]
    print("─" * 60)
    print(final_msg.content)
    print("─" * 60)

    bal = axon.wallet.balance()
    print(f"Wallet now: {bal['available_usdc']} USDC available")


if __name__ == "__main__":
    main()
