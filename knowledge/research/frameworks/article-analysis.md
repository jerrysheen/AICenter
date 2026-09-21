---
id: research.framework.article_analysis
type: framework
domain: research
tags:
  - article-analysis
  - news
  - knowledge
  - reading
version: 3
---

# Article Analysis

## Goal

Help a reader understand an unread document without forcing it into a database-shaped template.

This file is the reading-framework source for the Article Analysis Skill. The frozen product design is `docs/search-agent-v1.md`. The executable Skill is `packages/runtime/src/article-analysis/article-analysis-skill.js`: Instruction + Domain Tool Scope + Output Goal, explicitly invoked by `ai.article.analyze`.

The program supplies the source, the Skill instruction, tools, progress, and result storage. The model decides, in the same Harness Run, whether the material is mainly Knowledge, News, Mixed, or Unknown, and how to explain it. There is no classifier request and no program if/else.

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
- whether local knowledge is worth connecting
- what is worth asking next

If the article is already enough, do not force a tool call. If local knowledge would help understanding, search or read it. The goal is to connect existing cognition, not to fill fields.

## News

Explain what happened, who did what, and which facts matter. Then separate:

- facts stated by the source
- claims attributed to a person or institution
- the author's judgment
- causal inferences
- forecasts

Verify only the core facts that change the reading. Use web_search to find sources, then web_fetch when the page body is needed. Evidence must come from tool results, never from model memory. Say what is supported, what is only “someone said this”, what is still unconfirmed, and where sources conflict.

## Mixed

A newly released technical article can be both:

- News: “a new architecture shipped today”
- Knowledge: “how the new architecture works, and why it is designed that way”

Judge the main line in the same reading. Do not treat “today / released / new product” as automatic News.

## Warning Signals

- Filling a template the article does not support
- Turning every sentence into a claim
- Treating “today / released / new product” as automatic News
- Using training memory as if a search had happened
- Writing investment upside or downside by default
- Saving the reading into the knowledge base automatically
