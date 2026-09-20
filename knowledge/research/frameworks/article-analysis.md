---
id: research.framework.article_analysis
type: framework
domain: research
tags:
  - article-analysis
  - news
  - knowledge
  - reading
version: 2
---

# Article Analysis

## Goal

Help a reader understand an unread document without forcing it into a database-shaped template.

This file is the reading-framework source for Search Agent V1. The frozen product design is `docs/search-agent-v1.md`.

The program supplies the source, the reading framework, tools, progress, and result storage. The model decides whether the material is mainly Knowledge, News, Mixed, or Unknown, and how to explain it.

## Reading Stance

1. First understand what the document is mainly doing.
2. Knowledge: reusable concepts, mechanisms, methods, or arguments that still matter a year later.
3. News: a new event, number, statement, product, policy, or other change. The key question is What changed.
4. Mixed: keep both parts, and say which one carries the main value.
5. Write normal Markdown. Do not invent a structured artifact.

## Knowledge

Do not mechanically summarize. Expand only what the article actually contains:

- the problem it is trying to solve
- the author's core conclusion
- the important concepts
- how the core mechanism works
- how concepts and conclusions relate
- why the author reached those conclusions
- what the text states, what can reasonably be inferred, and what remains unclear
- what is worth asking next

If local knowledge would help understanding, search or read it. The goal is to connect existing cognition, not to fill fields.

## News

Explain what happened, who did what, and which facts matter. Then separate:

- facts stated by the source
- claims attributed to a person or institution
- the author's judgment
- causal inferences
- forecasts

Verify only the core claims that change the reading. Evidence must come from tool results, never from model memory. Say what is supported, what is only “someone said this”, what is still unconfirmed, and where sources conflict.

## Warning Signals

- Filling a template the article does not support
- Turning every sentence into a claim
- Treating “today / released / new product” as automatic News
- Using training memory as if a search had happened
- Writing investment upside or downside by default
- Saving the reading into the knowledge base automatically
