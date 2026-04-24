---
term: MCP
shortDefinition: Model Context Protocol — padrão aberto da Anthropic (2024) pra conectar ferramentas externas a LLMs. Usado em Claude Desktop, Cursor, Zed e VS Code.
lang: pt-BR
relatedTerms: [x402]
---

# MCP (Model Context Protocol)

**MCP** é um protocolo aberto publicado pela Anthropic em novembro de 2024, que padroniza como LLMs se conectam a **ferramentas externas** (APIs, databases, filesystems).

## O problema que MCP resolve

Antes do MCP, cada cliente de LLM (Claude Desktop, Cursor, Zed) tinha sua forma própria de integrar ferramentas. Desenvolvedores precisavam escrever a mesma integração N vezes, uma pra cada cliente.

MCP é tipo "USB-C pra LLMs": você escreve um **MCP server** uma vez, e ele funciona em qualquer cliente MCP-compatível.

## Arquitetura

- **MCP Server:** processo que expõe tools (funções), resources (arquivos/dados) e prompts
- **MCP Client:** LLM ou app que consome o server via stdio ou HTTP
- **Protocolo:** JSON-RPC sobre stdio (padrão), ou HTTP+SSE (remoto)

## Exemplo real

`@axon/mcp-server` é um servidor MCP que expõe todas as 28 APIs do Axon como tools. Instalando no Claude Desktop, o Claude ganha poder de chamar SerpAPI, Firecrawl, OpenAI embeddings — tudo via comando de texto.

## Quem adotou

- Claude Desktop (nativo)
- Cursor IDE
- Zed editor
- VS Code (com extensão)
- Continue.dev

## Relacionado

- [x402](/learn/glossary/x402)
- Guia futuro: "MCP Developer Guide"
