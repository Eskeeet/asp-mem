# Security and privacy

## Reporting a vulnerability

Please do not open a public issue for a vulnerability involving data exposure, tenant isolation, or prompt injection. Use GitHub's private vulnerability reporting for this repository.

## Memory is sensitive data

Conversational memory can contain identity, health, financial, relationship, location, or belief data. Production integrations should:

- obtain meaningful consent before long-term storage;
- minimize captured fields and reject credentials or secrets;
- define retention and expiry rules;
- encrypt data in transit and at rest;
- isolate every operation by owner/tenant;
- use the narrowest applicable organization, agent, and session scope;
- support access, export, correction, and deletion requests;
- avoid embedding data with a provider whose data policy is unacceptable for the use case.

The included Supabase schema enables row-level security for authenticated users. A service-role key bypasses those policies and must never be exposed to clients.

`MemoryAccessPolicy` is the application authorization hook. Database RLS and the policy should enforce compatible rules. Scope matching prevents a narrowly scoped record from appearing in a broader query, but it does not decide whether an actor is entitled to make that query.

## Prompt injection

Stored memories are untrusted input. The default context renderer escapes markup and labels the block as data, but formatting alone is not a security boundary. Never derive tool authority, authentication, or data access from model output. Keep system instructions and authorization checks outside the model.

## Extraction accuracy

Model-generated memories can be wrong. The default extraction prompt only requests facts explicitly supplied by the user, but applications should validate domain-sensitive candidates and provide a user-facing way to inspect and correct stored memories.

Assistant and tool attribution is disabled in turn capture unless explicitly allowed. Consolidation is a proposal mechanism: keep dry-run enabled until a trusted process or user has reviewed the actions. Supersession and retraction preserve history; use `forget()` when a privacy request requires actual deletion.
