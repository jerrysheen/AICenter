---
id: finance.framework.tech_growth
type: framework
domain: finance
tags:
  - technology
  - growth
  - SaaS
  - AI
  - valuation
  - ARR
  - unit-economics
  - gross-margin
  - utilization
  - capital-efficiency
  - 科技成长
  - 高增长
  - 毛利
  - 估值
  - 资本效率
version: 1
---

# Technology Growth Company Analysis

## Goal

Evaluate whether high growth creates durable economic value.

## Analysis Chain

1. Demand
2. Monetization
3. Unit Economics
4. Scale Efficiency
5. Growth Quality
6. Capital Efficiency
7. Operating Leverage
8. Valuation

## Core Metrics

### Demand
- users
- paid_users
- usage
- customer_growth

### Monetization
Revenue growth decomposition:

revenue ≈ users × paid_rate × usage_per_user × unit_price

For recurring businesses:

ARR = current recurring revenue run-rate annualized

ARR growth drivers:
- customer growth
- paid conversion
- usage expansion
- price increase

### Unit Economics

gross_margin = 1 - unit_cost / unit_price

Investigate:
- pricing power
- cost reduction
- product mix
- infrastructure efficiency

### Scale Efficiency

Check whether scale reduces unit cost.

Typical metrics:
- GPU utilization
- capacity utilization
- server utilization
- fab utilization
- load factor

Interpretation:

revenue ↑ + utilization ↑ + unit_cost ↓
= positive scale effect

### Growth Quality

Check:
- recurring vs one-off
- retention
- customer concentration
- price-driven vs volume-driven growth
- organic vs acquisition-driven growth

### Capital Efficiency

Evaluate:

incremental revenue / incremental invested capital

incremental gross profit / incremental invested capital

High revenue growth with disproportionately high capital requirement
should receive lower quality assessment.

### Operating Leverage

Preferred pattern:

revenue ↑
gross_margin ↑
opex_ratio ↓
free_cash_flow ↑

### Valuation

Select valuation metric based on company stage.

High-growth recurring business:
EV / ARR

Growth software:
EV / Revenue

Mature profitable company:
PE
FCF Yield

Valuation multiple must be interpreted together with:
- growth rate
- gross margin
- growth quality
- capital intensity
- durability

## Preferred Signal

Strongest pattern:

ARR ↑↑
gross_margin ↑
unit_cost ↓
utilization ↑
capital_efficiency ↑

## Warning Signals

- ARR growth driven mainly by temporary large customers
- price cuts required to sustain usage
- gross margin deteriorates with scale
- customer concentration increases
- capex grows faster than gross profit
- valuation assumes future margins not yet demonstrated

## Decision Rules

- Treat this document as a reasoning structure, not as current company facts.
- Pull current ARR, margins, utilization and prices from Source / market / web tools.
- Do not conclude quality from growth rate alone.
- Do not treat a high valuation multiple as confirmation of quality.

## Related Knowledge

- finance.industry.ai_model (planned)
- finance.concepts.arr (planned)
- finance.framework.valuation (planned)
