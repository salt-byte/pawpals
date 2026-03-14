---
name: managing-tech-debt
description: Tactical advice on managing tech debt from 18 product leaders (20 insights). Use when working on tech debt, technical debt, refactoring, legacy code. Category: Engineering.
---

# Managing Tech Debt

## What This Covers
- Tech debt
- Technical debt
- Refactoring
- Legacy code
- Code quality

## Top Insights

### From Camille Fournier
*Camille Fournier*

> "Engineers notoriously, notoriously, notoriously, massively underestimate the migration time for old system to new system and that causes a lot of problems. By the way, you still have to support the old system while you're working on the new system."

**Key insight:** Full system rewrites are often traps because teams underestimate migration time and the burden of supporting two systems simultaneously.

**Apply this by:**
- Account for significant migration time when planning system updates
- Plan for the resource cost of supporting the legacy system during a transition

### From Matt Mullenweg
*Matt Mullenweg*

> "Well, that's why I think technical debt is one of the most interesting concepts. There's so many companies as well that maybe have big market caps, but I feel like they might have billions or tens of billions of dollars of technical debt. You can see in the interface or how their products integrate..."

**Key insight:** Technical debt is often visible to the end-user through fragmented interfaces and poor product integration.

**Apply this by:**
- Identify technical debt by looking for inconsistencies in the user interface and product silos

### From Adriel Frederick
*Adriel Frederick*

> "The answer was like, Yo, we got to rebuild it. There was no answer where we couldn't have a product like this. We needed some ability to be able to influence prices so that we could actually run an effective marketplace. The current solution didn't work. It wasn't as operationally flexible as we..."

**Key insight:** When a technical solution lacks the operational flexibility required by the business, a full rebuild is often necessary despite the emotional and resource cost.

**Apply this by:**
- Evaluate if current technical debt is preventing necessary operational control.
- Be willing to admit when a complex algorithmic approach has failed and pivot to a more flexible architecture.

### From Austin Hay
*Austin Hay*

> "The job of a marketing technologist is to think often one to two years down the road about what we're going to need to solve for and design systems in an elegant way, not to break the bank, but to at least be the minimum viable product to actually get there. And a lot of my job, and I think the job..."

**Key insight:** Preventing future technical debt requires architecting systems that are 'minimally invasive' today but scalable for needs 1-2 years out.

**Apply this by:**
- When setting up tools, ask: 'What happens a year from now if I don't change anything?'
- Implement foundational elements like SSO or proper data schemas early to avoid catastrophic migrations later.

### From Casey Winters
*Casey Winters*

> "The idea is that some of the most impactful projects that product teams can work on at scale... are the hardest to measure. And because of that, they just get chronically underfunded... I walk through some examples of a few tactics that work to get around this problem, building custom metrics to..."

**Key insight:** Securing investment for non-sexy technical improvements requires quantifying their value through custom metrics and small-scale experiments.

**Apply this by:**
- Build custom metrics to demonstrate the business value of performance or stability
- Run small tests to prove that technical investments will yield long-term results
- Align with engineering and design peers to present a unified front for technical investments

## Deep Dive

For insights from all 18 guests, see `references/guest-insights.md`

## Related Skills
- Technical Roadmaps
- Platform & Infrastructure
- Engineering Culture
- Design Engineering
