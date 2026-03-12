# Monetization Paths

Cognitive kernels become autonomous operators when connected to MCPs.
The kernel provides coordination (topology, blackboard, metacog, gates).
MCPs provide hands (browser, shell, APIs, databases, messaging).
The domain specification tells the system what to care about.

Each path below is ranked by directness to revenue.

## 1. Automated RFP / Proposal Writer

**Input**: An RFP document + company context.
**Output**: A completed proposal addressing every requirement.

The kernel researches requirements, decomposes sections across workers,
reviewer ensures compliance with every stated requirement, observer
verifies formatting and completeness.

**MCPs**: filesystem, shell, browser (for research).
**Market**: Government contractors, agencies, consultancies. They spend
days on these manually. Clear per-proposal pricing ($200-500).
**Why it works**: Decomposition is natural (sections are independent),
quality is verifiable (did it address requirement X — yes or no),
and the existing spend is obvious and large.

## 2. Competitive Intelligence Service

**Input**: "Our product is X."
**Output**: Structured report — competitors, pricing, features, recent
changes, positioning gaps, market trends.

Parallax-style research topology. Workers investigate different
competitors in parallel, reviewer synthesizes and checks consistency,
observer verifies claims against sources.

**MCPs**: browser, web search.
**Market**: Every product team does this manually or pays consultants
($5K-50K per engagement). Automate for $200/report or monthly
monitoring subscription.
**Why it works**: Multi-source synthesis is where the kernel shines.
Single LLM calls produce shallow reports. Coordinated research with
cross-checking produces depth.

## 3. Content Repurposing Pipeline

**Input**: A long-form asset (podcast transcript, video, whitepaper).
**Output**: Blog posts, social threads, email sequences, newsletter
content — all maintaining consistent voice and messaging.

Workers handle different formats in parallel, reviewer ensures voice
consistency and messaging alignment across all outputs.

**MCPs**: filesystem, CMS API (WordPress, Ghost, etc.).
**Market**: Every marketing team does this manually. Per-asset pricing
($50-200) or monthly retainer. High volume, low complexity per unit.
**Why it works**: Embarrassingly parallel. Each output format is
independent. Quality bar is "good enough to edit" not "perfect."

## 4. Deployment Pipeline Operator

**Input**: Git push event (webhook).
**Output**: Tested, verified, deployed artifact — or rollback with
diagnosis.

Monitor repo, run tests, deploy to staging, verify the deployment
actually works (browser + shell observation), promote to production
or roll back with an incident report.

**MCPs**: GitHub, shell, browser, cloud provider CLI.
**Market**: Monthly per-repo pricing. Competes with Vercel/Railway
but adds the verification loop — it doesn't just deploy, it checks
that the deployment works before promoting.
**Why it works**: The observation gate is the differentiator. Current
CI/CD deploys blind. This deploys with eyes.

## 5. Customer Support Triage + Resolution

**Input**: New support ticket (via helpdesk integration).
**Output**: Resolution or drafted response for human approval.

Kernel reads tickets, diagnoses issues (checks docs, codebase, logs),
resolves directly or drafts responses. Gate/review topology ensures
nothing goes to the customer without oversight.

**MCPs**: helpdesk (Zendesk, Intercom), browser, shell, codebase.
**Market**: Per-ticket pricing or monthly. Every SaaS company has
support costs they'd love to reduce.
**Why it works**: The gate topology provides the safety net.
Auto-resolve simple tickets, escalate complex ones with context
already gathered. Humans review, not triage.

## 6. Codebase Migration Operator

**Input**: "Migrate from Express to Hono" or "Upgrade React 17 to 19."
**Output**: Migrated codebase with passing tests.

Kernel analyzes the codebase, decomposes changes by module, workers
migrate in parallel with file exclusivity, reviewers verify,
test suite validates.

**MCPs**: filesystem, shell.
**Market**: Per-migration pricing. This is where Construct already
works — scoped to a specific, sellable task instead of open-ended
"build anything."
**Why it works**: Clear input, clear output, verifiable result
(tests pass or they don't). Companies put off migrations for years
because they're tedious.

---

## Common thread

The kernel is most valuable when the task needs decomposition +
parallel execution + verification and people currently pay humans
to do it slowly. The weaker the case for coordination, the more
it's just a wrapper around a single LLM call.
